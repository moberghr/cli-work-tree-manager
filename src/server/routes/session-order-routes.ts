import type { Hono } from 'hono';
import { cleanOrder } from '../../core/rail/session-order.js';
import { readSessionOrder, writeSessionOrder } from '../../core/rail/session-order-store.js';
import { searchConversations } from '../../core/conversations/conversation-store.js';
import { loadHistory } from '../../core/sessions/history.js';

/**
 * The sessions list's manual order (drag to reorder):
 *
 *   GET /api/session-order    {order: string[]}  session ids, top first
 *   PUT /api/session-order    {order: string[]}  replaces it; every window is told
 */
export function mountSessionOrderRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  app.get('/api/session-order', (c) => c.json({ order: readSessionOrder() }));

  // Search every session's kept conversation, live and archived (read-only).
  app.get('/api/conversations/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ hits: [] });
    return c.json({ hits: await searchConversations(q, { sessions: loadHistory() }) });
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
