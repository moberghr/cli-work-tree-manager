import type { Hono } from 'hono';
import { cleanPlacePatch, cleanSectionOp } from '../../core/rail/rail-layout.js';
import { changeRailSections, placeSession, readRailLayout } from '../../core/rail/rail-store.js';
import { findSession } from '../../core/sessions/web-state.js';

/**
 * The rail's pins and sections (rail-layout.ts):
 *
 *   GET /api/rail                    RailLayout
 *   POST /api/rail/sections          {op: add|rename|move|remove, id, name?, by?}  one change, to the list as it is now
 *   PUT /api/sessions/:id/rail       {pinned?, section?: id | null}
 *
 * Every window is told (`rail-changed`).
 */
export function mountRailRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  const changed = () => opts.broadcast('rail-changed', { ts: Date.now() });

  app.get('/api/rail', (c) => c.json(readRailLayout()));

  app.post('/api/rail/sections', async (c) => {
    const op = cleanSectionOp(await c.req.json().catch(() => null));
    if (!op) return c.json({ error: 'expected {op: add|rename|move|remove, id, name?, by?}' }, 400);
    const r = changeRailSections(op);
    if (!r.ok) return c.json({ error: r.error }, 409);
    changed();
    return c.json(r.layout);
  });

  app.put('/api/sessions/:id/rail', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const patch = cleanPlacePatch(await c.req.json().catch(() => null));
    if (!patch) return c.json({ error: 'expected {pinned?: boolean, section?: string | null}' }, 400);
    const r = placeSession(id, patch);
    if (!r.ok) return c.json({ error: r.error }, 409);
    changed();
    return c.json(r.layout);
  });
}
