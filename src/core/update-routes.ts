import type { Context, Hono } from 'hono';
import { findSession } from './web-state.js';
import { moveOntoMain, updateFromBase, type SessionUpdate } from './session-update.js';
import type { CommandRunner } from './ship.js';
import type { UpdateFromMainWire } from './api-types.js';

/**
 * The dashboard's update buttons (session-update.ts, shared with `work update`):
 *
 *   POST /api/sessions/:id/update-from-main  from origin/<main> — or, stacked, from its parent's branch
 *   POST /api/sessions/:id/retarget          stacked on a merged session: onto main
 */
export function mountUpdateRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; changed?: (id: string) => void; run?: CommandRunner },
): void {
  // Written out per route (not built from a list): the demo contract test finds routes by their literal paths.
  const handle = (act: typeof updateFromBase) => async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    const r: SessionUpdate = await act(s, opts.run);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    opts.changed?.(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results: r.results } satisfies UpdateFromMainWire);
  };
  app.post('/api/sessions/:id/update-from-main', handle(updateFromBase));
  app.post('/api/sessions/:id/retarget', handle(moveOntoMain));
}
