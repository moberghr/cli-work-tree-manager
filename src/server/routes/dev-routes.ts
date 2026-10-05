import type { Hono } from 'hono';
import { loadConfig } from '../../core/platform/config.js';
import { findSession } from '../../core/sessions/web-state.js';
import { devLogTail, devState, startDev, stopDev } from '../../core/worktree/dev-server.js';

/**
 * Per-worktree dev server + preview (see dev-server.ts):
 *
 *   GET  /api/sessions/:id/dev        port, listening?, command, running
 *   POST /api/sessions/:id/dev/start  run the configured dev command on $PORT
 *   POST /api/sessions/:id/dev/stop   stop it (whole process tree)
 *   GET  /api/sessions/:id/dev/log    tail of its output, text/plain
 */
export function mountDevRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  app.get('/api/sessions/:id/dev', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return c.json(await devState(id, session, loadConfig()));
  });

  app.post('/api/sessions/:id/dev/start', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const out = startDev(id, session, loadConfig());
    if (!out.ok) return c.json({ error: out.error }, out.status);
    opts.broadcast('dev-changed', { sessionId: id });
    return c.json(out);
  });

  app.post('/api/sessions/:id/dev/stop', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const stopped = stopDev(id);
    opts.broadcast('dev-changed', { sessionId: id });
    return c.json({ ok: true, stopped });
  });

  app.get('/api/sessions/:id/dev/log', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.text(devLogTail(id) || '(no output yet)');
  });
}
