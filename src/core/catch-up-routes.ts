import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { cachedCatchUp, catchUp, type CatchUpFacts } from './catch-up.js';
import { runClaude } from './checkpoint-summary.js';
import { readStatus } from './session-status.js';
import type { CatchUpWire } from './api-types.js';

/**
 * "Catch me up" (catch-up.ts), for the session header:
 *
 *   GET  /api/sessions/:id/catch-up  — the last summary, if the conversation hasn't grown (runs nothing)
 *   POST /api/sessions/:id/catch-up  — write one (an internal Claude, no tools)
 */
/** The internal Claude that writes them (no tools). */
export const askCatchUp = (prompt: string) => runClaude(prompt, 90_000);

/** What the summary may say besides the conversation: its status, plus what the caller adds (the uncommitted size). */
export function catchUpFacts(id: string, extra: CatchUpFacts = {}): CatchUpFacts {
  const st = readStatus(id);
  return { ...(st ? { status: `${st.state}${st.summary ? ` (${st.summary})` : ''}` } : {}), ...extra };
}

export function mountCatchUpRoutes(
  app: Hono,
  opts: { ask?: (prompt: string) => Promise<string | null>; facts?: (id: string) => CatchUpFacts } = {},
): void {
  const ask = opts.ask ?? askCatchUp;
  const facts = (id: string): CatchUpFacts => catchUpFacts(id, opts.facts?.(id));

  app.get('/api/sessions/:id/catch-up', (c) => {
    const s = findSession(c.req.param('id'));
    if (!s) return c.json({ error: 'unknown session' }, 404);
    return c.json({ catchUp: cachedCatchUp(s) } satisfies CatchUpWire);
  });

  app.post('/api/sessions/:id/catch-up', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    const result = await catchUp(s, ask, facts(id));
    if (!result) return c.json({ error: 'Nothing to go on: no conversation in the last week, or no answer from Claude.' }, 422);
    return c.json({ catchUp: result } satisfies CatchUpWire);
  });
}
