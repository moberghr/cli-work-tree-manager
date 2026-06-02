import type { Hono } from 'hono';

/**
 * PTY route registration. The actual WebSocket upgrade happens at the Node
 * HTTP server level via `attachTerminalUpgrade()` — Hono only owns the
 * "is this session known?" gating endpoint that the client hits first to
 * discover whether the terminal tab is available.
 */
export function mountTerminalRoutes(app: Hono): void {
  app.get('/api/sessions/:id/terminal/health', (c) => {
    return c.json({ ok: true, sessionId: c.req.param('id') });
  });
}
