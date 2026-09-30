import type { Hono } from 'hono';
import { cleanOrder } from './session-order.js';
import { readSessionOrder, writeSessionOrder } from './session-order-store.js';

/**
 * The sessions list's manual order (drag to reorder):
 *
 *   GET /api/session-order    {order: string[]}  session ids, top first
 *   PUT /api/session-order    {order: string[]}  replaces it; every window is told
 */
export function mountSessionOrderRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  app.get('/api/session-order', (c) => c.json({ order: readSessionOrder() }));

  app.put('/api/session-order', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { order?: unknown } | null;
    const order = cleanOrder(body?.order);
    if (!order) return c.json({ error: 'order must be an array of session ids' }, 400);
    writeSessionOrder(order);
    opts.broadcast('session-order-changed', { ts: Date.now() });
    return c.json({ order });
  });
}
