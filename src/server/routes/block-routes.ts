import type { Hono } from 'hono';
import { addBlocker, blockRefFrom, removeBlocker } from '../../core/rail/session-blocks.js';
import { findSession } from '../../core/sessions/web-state.js';

/**
 * "Blocked by" (session-blocks.ts):
 *
 *   POST   /api/sessions/:id/blocks         {kind: 'session', id} | {kind: 'pr', url}
 *   DELETE /api/sessions/:id/blocks?key=…   stop waiting on one thing (no key: on all)
 */
export function mountBlockRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void; changed?: () => void }): void {
  app.post('/api/sessions/:id/blocks', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as { kind?: unknown; id?: unknown; url?: unknown } | null;
    const ref = blockRefFrom(body);
    if (!ref) return c.json({ error: "expected {kind: 'session', id} of a live session, or {kind: 'pr', url} of a GitHub pull request" }, 400);
    const r = addBlocker(id, ref);
    if (!r.ok) return c.json({ error: r.error }, 409);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    opts.changed?.();
    return c.json({ ok: true, block: r.block });
  });

  app.delete('/api/sessions/:id/blocks', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    removeBlocker(id, c.req.query('key') || undefined);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });
}
