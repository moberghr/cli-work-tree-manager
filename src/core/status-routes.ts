import path from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { findSessionForCwd } from './pending-delivery.js';
import { sessionIdFor, findSession } from './web-state.js';
import { markSeen, notifyKindForTransition, readStatus } from './session-status.js';
import { notifyDesktop } from './notifier.js';
import { runStatusHooks } from './status-hooks.js';

export interface StatusRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
}

/**
 * Attention inbox routes.
 *
 *   POST /api/status-changed      {cwd} — nudge from `work hook status-*`
 *                                  after it recorded a Claude hook event
 *   POST /api/sessions/:id/seen   — the user opened the session
 *
 * Status itself lives in ~/.work/status/ (written by the hook process), so a
 * missed nudge only delays the dashboard until its next refresh.
 */
export function mountStatusRoutes(app: Hono, opts: StatusRoutesOptions): void {
  // Guards against a nudge replayed for the same write (e.g. two hooks
  // racing) notifying twice: remember the last status write we acted on.
  const lastNotified = new Map<string, string>();

  app.post('/api/status-changed', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cwd?: unknown };
    if (typeof body.cwd !== 'string') return c.json({ error: 'cwd required' }, 400);
    const session = findSessionForCwd(body.cwd);
    if (!session) return c.json({ ok: true, matched: false });
    const id = sessionIdFor(session);
    const status = readStatus(id);
    if (status && lastNotified.get(id) !== status.updatedAt) {
      lastNotified.set(id, status.updatedAt);
      const kind = notifyKindForTransition(
        status.prevState ? { state: status.prevState } : null,
        status,
      );
      if (kind) {
        const config = loadConfig();
        // Named like the dash names it: the launch dir's basename.
        const launchDir = session.isGroup && session.paths[0]
          ? path.dirname(session.paths[0])
          : session.paths[0] ?? body.cwd;
        const name = `${session.target} · ${session.branch}`;
        notifyDesktop(name, kind, { enabled: config?.notifications === true });
        runStatusHooks(kind, launchDir, name, config?.statusHooks);
      }
    }
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true, matched: true, sessionId: id });
  });

  app.post('/api/sessions/:id/seen', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const status = await markSeen(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true, status });
  });
}
