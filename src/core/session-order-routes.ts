import type { Hono } from 'hono';
import { cleanOrder } from './session-order.js';
import { readSessionOrder, writeSessionOrder } from './session-order-store.js';
import { searchArchives } from './archive-search.js';
import { archiveRoot } from './session-archive.js';
import { loadHistory } from './history.js';
import { sessionIdFor } from './session-id.js';

/**
 * The sessions list's manual order (drag to reorder):
 *
 *   GET /api/session-order    {order: string[]}  session ids, top first
 *   PUT /api/session-order    {order: string[]}  replaces it; every window is told
 */
export function mountSessionOrderRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  app.get('/api/session-order', (c) => c.json({ order: readSessionOrder() }));

  // Search the conversations kept by archived sessions (read-only).
  app.get('/api/archive/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ hits: [] });
    const archived = new Set(loadHistory().filter((s) => s.archivedAt).map(sessionIdFor));
    return c.json({ hits: await searchArchives(q, archiveRoot(), (id) => archived.has(id)) });
  });

  app.put('/api/session-order', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { order?: unknown } | null;
    const order = cleanOrder(body?.order);
    if (!order) return c.json({ error: 'order must be an array of session ids' }, 400);
    writeSessionOrder(order);
    opts.broadcast('session-order-changed', { ts: Date.now() });
    return c.json({ order });
  });
}
