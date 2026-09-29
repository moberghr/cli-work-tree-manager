import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { setupWorktree, teardownWorktree, wouldRefuseRemoval } from './worktree.js';
import { removeSession } from './history.js';
import {
  disposeSessionWatcher,
  findSession,
  sessionIdFor,
} from './web-state.js';
import { disposePty, getWorkBin, spawnSpecFor } from './pty-pool.js';
import { git } from './git.js';
import { detectParentBranch } from './diff-scope.js';

export interface WorktreeMutOptions {
  broadcast: (event: string, data: unknown) => void;
}

/**
 * Hono sub-app exposing the dashboard's worktree mutation surface:
 *
 *   POST   /api/worktrees             — create (target + branch [+ base])
 *   DELETE /api/sessions/:id/worktree — remove (force / sessionOnly flags)
 *   POST   /api/sessions/:id/sync     — git fetch (+ pull where safe)
 *   POST   /api/sessions/:id/rebase   — rebase on detected/recorded parent
 *   POST   /api/sessions/:id/open-editor — spawn `code <path>`
 *   POST   /api/sessions/:id/open-terminal — Windows Terminal tab running
 *                                           `work attach` for the session
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
        // immediately (it's just sha1(target:branch)).
        const id = sessionIdFor({ target, branch });
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
  const REFUSED =
    'Worktree not removed: uncommitted changes, unpushed commits, ' +
    'or git refused. Retry with force, or forget the session only.';
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
        const onDisk = session.paths.some((p) => fs.existsSync(p));
        // A removal that will be refused (uncommitted or unpushed work,
        // no force) must leave the agent working in there alone — decide
        // BEFORE stopping anything, as `work remove` does.
        if (!sessionOnly && onDisk && session.paths.some((p) => wouldRefuseRemoval(p, force ?? false))) {
          return c.json({ error: REFUSED }, 409);
        }

        // Release our own handles on the tree first — a live Claude PTY
        // (cwd inside the worktree) or an open directory watch blocks the
        // delete on Windows.
        await disposePty(id);
        await disposeSessionWatcher(id);

        let worktreeRemoved = false;
        if (!sessionOnly && onDisk) {
          const ok = teardownWorktree(
            session.target,
            session.isGroup,
            session.branch,
            config,
            force ?? false,
          );
          if (!ok) return c.json({ error: REFUSED }, 409);
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
  app.post('/api/sessions/:id/open-editor', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    // Open the worktree (or group root) in VS Code. Detached + ignored
    // stdio so the spawn returns immediately and the parent doesn't
    // hold on to a zombie.
    const target = session.isGroup
      ? path.dirname(session.paths[0])
      : session.paths[0];
    // cross-spawn, not node's spawn: the editor is usually a `.cmd` shim on
    // Windows (code.cmd), which node refuses to run without a shell since
    // the BatBadBut fix (EINVAL) — and a shell would interpret `&` etc. in
    // the path. cross-spawn escapes the argument for cmd.exe instead.
    const editor = loadConfig()?.editor?.trim() || 'code';
    const failed = await new Promise<string | null>((resolve) => {
      try {
        const child = crossSpawn(editor, [target], { detached: true, stdio: 'ignore', windowsHide: true });
        // A missing editor surfaces as 'error' — on Windows only when the
        // cmd.exe wrapper exits (cross-spawn turns that exit into ENOENT) —
        // so wait for an error, an exit, or a moment of it running.
        const settle = setTimeout(() => resolve(null), 1500);
        child.once('error', (err) => {
          clearTimeout(settle);
          resolve(err.message);
        });
        child.once('exit', () => {
          clearTimeout(settle);
          resolve(null); // `code` hands off to the running editor and exits
        });
        child.unref();
      } catch (err) {
        resolve((err as Error).message);
      }
    });
    if (failed) return c.json({ error: `could not start ${editor}: ${failed}` }, 500);
    return c.json({ ok: true, opened: target });
  });

  // -- Open in a real terminal -------------------------------------------
  // A new Windows Terminal tab (in the most recent window) running
  // `work attach` from the session's launch dir — attach resolves the
  // session from its cwd, so no branch name ever reaches wt's parser.
  // argv array, no shell (§1.1). wt splits its OWN command line on `;`,
  // so a path or title containing one is refused/stripped rather than
  // escaped.
  app.post('/api/sessions/:id/open-terminal', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    const spec = session ? spawnSpecFor(session) : null;
    if (!session || !spec) return c.json({ error: 'unknown session' }, 404);
    if (process.platform !== 'win32') {
      return c.json(
        { error: 'Only Windows Terminal is supported so far — run `work attach` in the worktree.' },
        501,
      );
    }
    if (spec.cwd.includes(';')) {
      return c.json({ error: 'worktree path contains ";", which wt.exe cannot take' }, 400);
    }
    const title = `${session.target} · ${session.branch || '(base)'}`.replace(/;/g, ' ');
    try {
      const child = spawn(
        'wt.exe',
        ['-w', '0', 'nt', '--title', title, '-d', spec.cwd, process.execPath, getWorkBin(), 'attach'],
        { detached: true, stdio: 'ignore', shell: false },
      );
      // A missing wt.exe fails asynchronously, after we've answered —
      // swallow it so it can't crash the server.
      child.on('error', () => {});
      child.unref();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
