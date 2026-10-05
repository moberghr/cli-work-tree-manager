import type { Hono } from 'hono';
import { markDiffSeen, readDiffSeen } from '../../core/diff/diff-seen.js';
import { findSession } from '../../core/sessions/web-state.js';
import type { DiffSeen } from '../../core/api-types.js';

/**
 * How far you have looked at a session's diff (diff-seen.ts):
 *
 *   GET  /api/sessions/:id/diff-seen   {seen}            (reads only)
 *   POST /api/sessions/:id/diff-seen   {checkpointId}    you looked this far (only moves forward)
 */
export function mountDiffSeenRoutes(app: Hono): void {
  app.get('/api/sessions/:id/diff-seen', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.json({ seen: readDiffSeen(id) } satisfies { seen: DiffSeen | null });
  });

  app.post('/api/sessions/:id/diff-seen', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as { checkpointId?: unknown } | null;
    const cp = body?.checkpointId;
    if (typeof cp !== 'number' || !Number.isInteger(cp) || cp < 0) return c.json({ error: 'expected {checkpointId}' }, 400);
    return c.json({ seen: markDiffSeen(id, cp) } satisfies { seen: DiffSeen });
  });
}
