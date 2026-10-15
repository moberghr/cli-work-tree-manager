import type { Hono } from 'hono';
import { findSession } from '../../core/sessions/web-state.js';
import { setSessionArchived, setSessionTitle } from '../../core/sessions/history.js';
import { loadConfig } from '../../core/platform/config.js';
import { archiveSession, restoreArchivedTranscripts } from '../../core/archive/session-archive.js';
import { defaultArchiveDeps } from '../../core/archive/session-archive-deps.js';
import { createInProcess, type CreateWorktree } from '../../core/worktree/setup-child.js';
import { isWorktreeFolder } from '../../core/worktree/leftover.js';
import type { Holders } from '../../core/platform/running-from.js';
import { freeLeftovers, leftoversOf, lookAtLeftovers, openInLeftovers } from '../../core/archive/restore-leftovers.js';
import {
  mergeSelected,
  runShipAction,
  shipPreflight,
  type CommandRunner,
  type MergeMethod,
  type MergeSelection,
  type ShipAction,
} from '../../core/pr/ship.js';

export interface ShipRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Called after git state changed (push/merge) so diff stats refresh. */
  onRepoChanged?: (sessionId: string) => void;
  run?: CommandRunner;
  /** Let go of a session's folders before its worktree is removed (watchers). */
  release?: (sessionId: string) => Promise<void>;
  /** How a removed worktree is made again on Restore (work web: in a child process, setup-child.ts). */
  create?: CreateWorktree;
  /** What runs from or names a folder, and stopping it (running-from.ts; tests swap them). */
  holders?: (dirs: string[]) => Promise<Holders>;
  stopHolders?: (dirs: string[]) => Promise<string[]>;
}

const ACTIONS = new Set<ShipAction>(['push', 'create-pr', 'merge']);
const METHODS = new Set<MergeMethod>(['squash', 'merge', 'rebase']);

/**
 *   GET  /api/sessions/:id/ship      preflight per repo (dirty, upstream, PR,
 *                                    checks, merge blockers)
 *   POST /api/sessions/:id/ship      {action: push|create-pr, draft?} or
 *                                    {action: merge, method?, repos: [{name,
 *                                    headSha}]} — merges exactly those repos at
 *                                    exactly those PR heads (all validated
 *                                    first); archives only when something was
 *                                    merged AND every repo is now done
 *   POST /api/sessions/:id/archive   {archived}: archive (session-archive.ts)
 *                                    keeps its conversation and a summary,
 *                                    removes the worktree when nothing would
 *                                    be lost, keeps the branch; {archived:
 *                                    false} restores it (worktree recreated,
 *                                    conversation put back)
 */
export function mountShipRoutes(app: Hono, opts: ShipRoutesOptions): void {
  const archive = async (
    id: string,
    archived: boolean,
    force = false,
    merged = false,
    stopHolders = false,
  ): Promise<{ ok: boolean; blocked?: string[]; message?: string; error?: string; holders?: string[] }> => {
    const session = findSession(id);
    if (!session) return { ok: false };
    let ok: boolean;
    if (archived) {
      const out = await archiveSession(session, defaultArchiveDeps({ release: opts.release }), { force, merged });
      if (out.blocked) return { ok: false, blocked: out.blocked, message: out.message };
      ok = out.ok;
    } else if (session.paths.some((p) => !isWorktreeFolder(p))) {
      // Its worktree was removed on archive (or only in part: a folder with no git left in
      // it, leftover.ts): recreate it from the branch
      // (`work tree` / setupWorktree also puts the conversation back and un-archives it).
      const config = loadConfig();
      if (!config) return { ok: false, error: 'no config' };
      // What's left of a folder git removed only in part has to be moved out of the way, and can't be while
      // something runs from it (a dev server its Claude left): say what, and stop it when asked to.
      const io = { holders: opts.holders, stop: opts.stopHolders };
      const leftovers = leftoversOf(session.paths);
      let stopped: string[] = [];
      // One look at the processes serves both questions (on Windows a look takes a second or more).
      let looked: Awaited<ReturnType<typeof lookAtLeftovers>> = null;
      if (stopHolders) stopped = await freeLeftovers(leftovers, io);
      else {
        looked = await lookAtLeftovers(leftovers, io);
        const running = looked?.running ?? [];
        if (running.length) {
          return { ok: false, holders: running, error: `Couldn't restore it: still running from its old folder: ${running.join(', ')}` };
        }
      }
      const made = await (opts.create ?? createInProcess)({ target: session.target, branch: session.branch }, config);
      // A Restore that couldn't make the worktree says why (a folder in use, a branch gone…), not "unknown session",
      // and names what has the folder open when it can (an editor: yours to close).
      if (!made.ok) {
        // Asked again only when something was stopped since the look.
        const open = looked && !stopped.length ? looked.open : await openInLeftovers(leftovers, io);
        return {
          ok: false,
          error: `Couldn't restore it: ${made.error}${open.length ? ` (open there: ${open.join(', ')})` : ''}${stopped.length ? ` (stopped first: ${stopped.join(', ')})` : ''}`,
        };
      }
      ok = true;
    } else {
      restoreArchivedTranscripts(session);
      ok = await setSessionArchived(session.target, session.branch, false);
    }
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return { ok };
  };

  // Name a session ({title}; empty = back to the automatic name).
  app.post('/api/sessions/:id/title', async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
    if (typeof body?.title !== 'string') return c.json({ error: 'title: string' }, 400);
    await setSessionTitle(session.target, session.branch, body.title);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/ship', async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return c.json(await shipPreflight(session, opts.run));
  });

  app.post('/api/sessions/:id/ship', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      method?: unknown;
      draft?: unknown;
      repos?: unknown;
    };
    if (typeof body.action !== 'string' || !ACTIONS.has(body.action as ShipAction)) {
      return c.json({ error: 'action must be push, create-pr or merge' }, 400);
    }
    if (body.method !== undefined && !METHODS.has(body.method as MergeMethod)) {
      return c.json({ error: 'method must be squash, merge or rebase' }, 400);
    }
    const action = body.action as ShipAction;

    if (action !== 'merge') {
      const results = await runShipAction(session, action, { draft: body.draft === true }, opts.run);
      opts.onRepoChanged?.(id);
      opts.broadcast('sessions-changed', { ts: Date.now() });
      return c.json({ results, archived: false });
    }

    // Merge: the client must say which repos, at which PR heads it showed
    // the user — never "whatever is there now".
    const selection = parseSelection(body.repos);
    if (!selection) {
      return c.json({ error: 'merge needs repos: [{ name, headSha }] — the PR heads you reviewed' }, 400);
    }
    const outcome = await mergeSelected(session, selection, (body.method as MergeMethod) ?? 'squash', opts.run);
    opts.onRepoChanged?.(id);
    let archived = false;
    if (outcome.mergedAny && outcome.allDone) {
      // Merged: drafts and notes are kept with the archive, not waited for (a turn in progress is).
      archived = (await archive(id, true, false, true)).ok;
    } else {
      opts.broadcast('sessions-changed', { ts: Date.now() });
    }
    return c.json({ results: outcome.results, archived, allDone: outcome.allDone });
  });

  app.post('/api/sessions/:id/archive', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown; force?: unknown; stopHolders?: unknown };
    if (typeof body.archived !== 'boolean') return c.json({ error: 'archived (boolean) required' }, 400);
    const r = await archive(c.req.param('id'), body.archived, body.force === true, false, body.stopHolders === true);
    // Work still waiting in it: say what, and let the user decide (force).
    if (r.blocked) return c.json({ error: r.message, blocked: r.blocked }, 409);
    // A Restore held up by what still runs from its old folder: say what, and let the user decide (stopHolders).
    if (r.holders) return c.json({ error: r.error, holders: r.holders }, 409);
    if (r.error) return c.json({ error: r.error }, 500);
    return r.ok ? c.json({ ok: true }) : c.json({ error: 'unknown session' }, 404);
  });
}

function parseSelection(v: unknown): MergeSelection[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: MergeSelection[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== 'object') return null;
    const { name, headSha } = x as { name?: unknown; headSha?: unknown };
    if (typeof name !== 'string' || typeof headSha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(headSha)) return null;
    if (seen.has(name)) return null;
    seen.add(name);
    out.push({ name, headSha });
  }
  return out;
}
