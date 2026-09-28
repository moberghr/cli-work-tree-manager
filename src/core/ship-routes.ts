import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { setSessionArchived } from './history.js';
import { disposePty } from './pty-pool.js';
import {
  mergeSelected,
  runShipAction,
  shipPreflight,
  type CommandRunner,
  type MergeMethod,
  type MergeSelection,
  type ShipAction,
} from './ship.js';

export interface ShipRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Called after git state changed (push/merge) so diff stats refresh. */
  onRepoChanged?: (sessionId: string) => void;
  run?: CommandRunner;
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
 *   POST /api/sessions/:id/archive   {archived}: archive stops the PTY and
 *                                    hides the session; worktree, branch and
 *                                    conversation are kept
 */
export function mountShipRoutes(app: Hono, opts: ShipRoutesOptions): void {
  const archive = async (id: string, archived: boolean): Promise<boolean> => {
    const session = findSession(id);
    if (!session) return false;
    if (archived) await disposePty(id);
    const ok = await setSessionArchived(session.target, session.branch, archived);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return ok;
  };

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
      action?: unknown; method?: unknown; draft?: unknown; repos?: unknown;
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
      archived = await archive(id, true);
    } else {
      opts.broadcast('sessions-changed', { ts: Date.now() });
    }
    return c.json({ results: outcome.results, archived, allDone: outcome.allDone });
  });

  app.post('/api/sessions/:id/archive', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    if (typeof body.archived !== 'boolean') return c.json({ error: 'archived (boolean) required' }, 400);
    const ok = await archive(c.req.param('id'), body.archived);
    return ok ? c.json({ ok: true }) : c.json({ error: 'unknown session' }, 404);
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
