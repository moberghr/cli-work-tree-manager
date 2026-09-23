import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { setupWorktree, teardownWorktree } from './worktree.js';
import { removeSession } from './history.js';
import {
  disposeSessionWatcher,
  findSession,
  sessionIdFor,
} from './web-state.js';
import { disposePty } from './pty-pool.js';
import { git } from './git.js';
import { detectParentBranch } from './diff-scope.js';

export interface WorktreeMutOptions {
  broadcast: (event: string, data: unknown) => void;
}

/**
 * Hono sub-app exposing the worktree mutation surface that the dashboard
 * needs to reach parity with `work dash`:
 *
 *   POST   /api/worktrees             — create (target + branch [+ base])
 *   DELETE /api/sessions/:id/worktree — remove (force / sessionOnly flags)
 *   POST   /api/sessions/:id/sync     — git fetch (+ pull where safe)
 *   POST   /api/sessions/:id/rebase   — rebase on detected/recorded parent
 *   POST   /api/sessions/:id/open-editor — spawn `code <path>`
 *
 * All mutations broadcast `sessions-changed` so the SPA refetches and
 * the sidebar updates without a manual refresh.
 */
export function mountWorktreeRoutes(
  app: Hono,
  opts: WorktreeMutOptions,
): void {
  // -- Create ------------------------------------------------------------
  const createSchema = z.object({
    target: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().optional(),
    jiraKey: z.string().optional(),
  });
  app.post(
    '/api/worktrees',
    zValidator('json', createSchema),
    async (c) => {
      const { target, branch, base, jiraKey } = c.req.valid('json');
      const config = loadConfig();
      if (!config) return c.json({ error: 'no config' }, 400);

      try {
        const result = await setupWorktree(
          target,
          branch,
          config,
          base,
          jiraKey,
        );
        if (!result) {
          return c.json({ error: 'setup failed (target not found?)' }, 400);
        }
        opts.broadcast('sessions-changed', { ts: Date.now() });
        // Re-derive the new session id so the client can route to it
        // immediately. sessionIdFor takes a WorktreeSession, but we
        // have the same inputs — hash sha1(target+':'+branch).
        const id = sessionIdFor({
          target,
          isGroup: result.isGroup,
          branch,
          paths: result.paths,
          createdAt: '',
          lastAccessedAt: '',
        });
        return c.json({
          sessionId: id,
          launchDir: result.launchDir,
          paths: result.paths,
        });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    },
  );

  // -- Remove ------------------------------------------------------------
  // `force` discards uncommitted/unpushed work; `sessionOnly` just forgets
  // the history entry and leaves the worktree on disk. When none of the
  // session's paths exist any more (removed by hand, `git worktree prune`,
  // ...) there's nothing to tear down, so we forget the session directly
  // instead of failing forever.
  const removeSchema = z.object({
    force: z.boolean().optional(),
    sessionOnly: z.boolean().optional(),
  });
  app.delete(
    '/api/sessions/:id/worktree',
    zValidator('json', removeSchema),
    async (c) => {
      const id = c.req.param('id');
      const session = findSession(id);
      if (!session) return c.json({ error: 'unknown session' }, 404);
      const config = loadConfig();
      if (!config) return c.json({ error: 'no config' }, 400);

      const { force, sessionOnly } = c.req.valid('json');
      try {
        // Release our own handles on the tree first — a live Claude PTY
        // (cwd inside the worktree) or an open directory watch blocks the
        // delete on Windows.
        disposePty(id);
        await disposeSessionWatcher(id);

        const onDisk = session.paths.some((p) => fs.existsSync(p));
        let worktreeRemoved = false;
        if (!sessionOnly && onDisk) {
          const ok = teardownWorktree(
            session.target,
            session.isGroup,
            session.branch,
            config,
            force ?? false,
          );
          if (!ok) {
            return c.json(
              {
                error:
                  'Worktree not removed: uncommitted changes, unpushed commits, ' +
                  'or git refused. Retry with force, or forget the session only.',
              },
              409,
            );
          }
          worktreeRemoved = true;
        }
        await removeSession(session.target, session.branch);
        opts.broadcast('sessions-changed', { ts: Date.now() });
        return c.json({ ok: true, worktreeRemoved });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    },
  );

  // -- Sync (fetch + try to pull) ---------------------------------------
  app.post('/api/sessions/:id/sync', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const results = session.paths.map((p) => {
      const fetch = git(['fetch', '--all', '--prune', '--quiet'], p);
      const pull = git(['pull', '--ff-only', '--quiet'], p);
      return {
        path: p,
        fetched: fetch.exitCode === 0,
        pulled: pull.exitCode === 0,
        pullError: pull.exitCode === 0 ? undefined : pull.stderr.trim(),
      };
    });
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results });
  });

  // -- Rebase on parent --------------------------------------------------
  app.post('/api/sessions/:id/rebase', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const results = session.paths.map((p) => {
      const parent = session.baseBranch ?? detectParentBranch(p);
      if (!parent) {
        return { path: p, ok: false, error: 'no parent branch detected' };
      }
      const r = git(['rebase', parent], p);
      return {
        path: p,
        ok: r.exitCode === 0,
        parent,
        error: r.exitCode === 0 ? undefined : r.stderr.trim(),
      };
    });
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results });
  });

  // -- Open in editor ----------------------------------------------------
  app.post('/api/sessions/:id/open-editor', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    // Open the worktree (or group root) in VS Code. Detached + ignored
    // stdio so the spawn returns immediately and the parent doesn't
    // hold on to a zombie.
    const target = session.isGroup
      ? path.dirname(session.paths[0])
      : session.paths[0];
    try {
      // Resolve `code` vs `code.cmd` by platform instead of using
      // shell:true. shell:true routes through cmd.exe / sh -c, which
      // means any shell metacharacters in `target` (an `&`, a backtick,
      // an unescaped quote) would execute — a TOCTOU risk if anything
      // ever writes a malformed path into history.json.
      const cmd = process.platform === 'win32' ? 'code.cmd' : 'code';
      const child = spawn(cmd, [target], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.unref();
      return c.json({ ok: true, opened: target });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
