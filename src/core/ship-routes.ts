import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { setSessionArchived } from './history.js';
import { disposePty } from './pty-pool.js';
import { runShipAction, shipPreflight, type CommandRunner, type MergeMethod, type ShipAction } from './ship.js';

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
 *   POST /api/sessions/:id/ship      {action, method?, draft?}; a fully
 *                                    successful merge also archives
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
      action?: unknown; method?: unknown; draft?: unknown;
    };
    if (typeof body.action !== 'string' || !ACTIONS.has(body.action as ShipAction)) {
      return c.json({ error: 'action must be push, create-pr or merge' }, 400);
    }
    if (body.method !== undefined && !METHODS.has(body.method as MergeMethod)) {
      return c.json({ error: 'method must be squash, merge or rebase' }, 400);
    }
    const action = body.action as ShipAction;
    const results = await runShipAction(
      session,
      action,
      { method: body.method as MergeMethod | undefined, draft: body.draft === true },
      opts.run,
    );
    opts.onRepoChanged?.(id);
    // Shipped = done with it: archive once every repo merged (or had
    // nothing to merge). A partial or refused merge leaves it alone.
    let archived = false;
    if (action === 'merge' && results.length > 0 && results.every((r) => r.ok)) {
      archived = await archive(id, true);
    } else {
      opts.broadcast('sessions-changed', { ts: Date.now() });
    }
    return c.json({ results, archived });
  });

  app.post('/api/sessions/:id/archive', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    if (typeof body.archived !== 'boolean') return c.json({ error: 'archived (boolean) required' }, 400);
    const ok = await archive(c.req.param('id'), body.archived);
    return ok ? c.json({ ok: true }) : c.json({ error: 'unknown session' }, 404);
  });
}
