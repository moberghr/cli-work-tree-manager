import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { readStatus } from './session-status.js';
import { updateFromMain, type UpdateResult } from './behind-main.js';
import type { CommandRunner } from './ship.js';
import type { UpdateFromMainWire } from './api-types.js';

/**
 * POST /api/sessions/:id/update-from-main — bring the session's branch(es) up
 * to date with origin/<main> (behind-main.ts). Not while its Claude is
 * working or waiting on you: the files would move under it.
 */
export function mountUpdateRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; changed?: (id: string) => void; run?: CommandRunner },
): void {
  app.post('/api/sessions/:id/update-from-main', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    if (s.archivedAt) return c.json({ error: 'it is archived: restore it first' }, 409);
    const state = readStatus(id)?.state;
    if (state === 'working' || state === 'needs_input') {
      return c.json({ error: `Not now: its Claude is ${state === 'working' ? 'working' : 'waiting for your answer'} (the files would change under it).` }, 409);
    }
    const results: UpdateResult[] = [];
    for (const p of s.paths) results.push(await updateFromMain(p, opts.run));
    opts.changed?.(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results } satisfies UpdateFromMainWire);
  });
}
