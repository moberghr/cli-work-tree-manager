import fs from 'node:fs';
import { archiveWaiting } from './session-archive-deps.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { teardownWorktree, wouldRefuseRemoval } from './worktree.js';
import { removeSession } from './history.js';
import {
  disposeSessionWatcher,
  findSession,
  sessionIdFor,
} from './web-state.js';
import { disposePty, ensurePty, getWorkBin, peekPty, spawnSpecFor } from './pty-pool.js';
import { getCommentFileStore } from './comment-file-store.js';
import { git } from './git.js';
import { detectParentBranch } from './diff-scope.js';
import { toBaseSpec } from './base-spec.js';
import { createInProcess, type CreateWorktree } from './setup-child.js';

export interface WorktreeMutOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Start the new session's Claude with a first prompt (tests inject). */
  startSession?: (sessionId: string, prompt: string) => Promise<StartOutcome>;
  /** Drop the session's diff scope (its watch and bookkeeping) before deleting it. */
  releaseScope?: (paths: string[]) => void;
  /** How a worktree is made: work web runs it in a child process (setup-child.ts), so its git doesn't hold up the server. */
  create?: CreateWorktree;
}

/** What happened to the first prompt of a created worktree. */
export type StartOutcome =
  | 'started' // Claude spawned in the PTY host with it
  | 'queued'; // the session was already running: delivered on its next turn

/**
 * Default `startSession`: spawn the session's Claude in the PTY host with
 * the prompt as its first message — or, when the worktree already existed
 * and its Claude is running, queue it like a review comment instead of
 * typing into a terminal that may be mid-turn or showing a prompt.
 */
export async function startSessionWithPrompt(sessionId: string, prompt: string): Promise<StartOutcome> {
  if (peekPty(sessionId)) {
    getCommentFileStore(sessionId).post({ side: 'general', status: 'published', author: 'user', body: prompt });
    return 'queued';
  }
  if (!(await ensurePty(sessionId, { initialPrompt: prompt }))) throw new Error('could not start the session');
  return 'started';
}

/**
 * Hono sub-app exposing the dashboard's worktree mutation surface:
 *
 *   POST   /api/worktrees             — create (target + branch [+ base] [+ first prompt])
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
    /** Empty or left out: the repo's own checkout, on the branch it has (`work tree <repo>`). */
    branch: z.string().optional(),
    base: z.string().optional(),
    jiraKey: z.string().optional(),
    /** Start Claude with this as its first message. */
    prompt: z.string().max(20_000).optional(),
    /** Name the session (its title); the branch stays its identity. */
    name: z.string().max(120).optional(),
  });
  const startSession = opts.startSession ?? startSessionWithPrompt;
  const create = opts.create ?? createInProcess;
  app.post(
    '/api/worktrees',
    zValidator('json', createSchema),
    async (c) => {
      const { target, base, jiraKey, prompt, name } = c.req.valid('json');
      const config = loadConfig();
      if (!config) return c.json({ error: 'no config' }, 400);
      const wanted = c.req.valid('json').branch?.trim() ?? '';
      if (!wanted && base?.trim()) return c.json({ error: 'a base needs a branch to fork (leave both empty to open the repo as it is)' }, 400);

      try {
        // No branch: the repo's own checkout, as `work tree <repo>` opens it.
        // A failure says why (core's reports, or the child run's errors).
        const made = await create({ target, branch: wanted || undefined, base: base?.trim() ? toBaseSpec(base.trim()) : undefined, jiraKey, name }, config);
        if (!made.ok) return c.json({ error: made.error }, 400);
        const branch = made.branch;
        const result = { launchDir: made.launchDir, paths: made.paths };
        opts.broadcast('sessions-changed', { ts: Date.now() });
        // Re-derive the new session id so the client can route to it
        // immediately (it's just sha1(target:branch)).
        const id = sessionIdFor({ target, branch });
        // The worktree exists either way; a failed start is reported, not
        // fatal (the Terminal tab can still start it by hand).
        let started: StartOutcome | undefined;
        let startError: string | undefined;
        if (prompt?.trim()) {
          try {
            started = await startSession(id, prompt.trim());
          } catch (err) {
            startError = (err as Error).message;
          }
          opts.broadcast('sessions-changed', { ts: Date.now() });
        }
        return c.json({
          sessionId: id,
          launchDir: result.launchDir,
          paths: result.paths,
          ...(started ? { started } : {}),
          ...(startError ? { startError } : {}),
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
      // What deleting would cut off — its Claude mid-turn or waiting on you,
      // replies to post, notes not yet delivered — refuses it unless forced,
      // as archiving does. (A clean worktree used to be deleted with its
      // Claude stopped mid-work: one click away with the bulk bar.)
      if (!force) {
        const waiting = archiveWaiting(id);
        if (waiting.length) return c.json({ error: `Not deleted: ${waiting.join('; ')}.`, blocked: waiting }, 409);
      }
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
        opts.releaseScope?.(session.paths);

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
