import type { Hono } from 'hono';
import { cleanPlacePatch, cleanSections } from './rail-layout.js';
import { placeSession, readRailLayout, saveRailSections } from './rail-store.js';
import { findSession } from './web-state.js';

/**
 * The rail's pins and sections (rail-layout.ts):
 *
 *   GET /api/rail                    RailLayout
 *   PUT /api/rail/sections           {sections: [{id, name}]}  replaces the list (add, rename, reorder, remove)
 *   PUT /api/sessions/:id/rail       {pinned?, section?: id | null}
 *
 * Every window is told (`rail-changed`).
 */
export function mountRailRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  const changed = () => opts.broadcast('rail-changed', { ts: Date.now() });

  app.get('/api/rail', (c) => c.json(readRailLayout()));

  app.put('/api/rail/sections', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sections?: unknown } | null;
    const sections = cleanSections(body?.sections);
    if (!sections) return c.json({ error: 'sections must be a list of {id, name} (at most 30, names not empty)' }, 400);
    const layout = saveRailSections(sections);
    changed();
    return c.json(layout);
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
