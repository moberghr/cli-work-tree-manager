import fs from 'node:fs';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createSeenStores } from './pr-watch-store.js';
import { loadHistory } from './history.js';
import { sessionIdFor } from './session-id.js';
import { findSession } from './web-state.js';
import { defaultRunner, shipPreflight } from './ship.js';
import { fetchReviewFeedback } from './pr-review.js';
import { createPrWatch, type PrWatch } from './pr-watch.js';

/**
 * The PR watch (pr-watch.ts) wired to real sessions, gh and the comment
 * route, plus its endpoints:
 *
 *   GET  /api/sessions/:id/ci      cached CI/PR state (re-checked if > 60 s old)
 *   POST /api/sessions/:id/ci/fix  tell the session's Claude to fix failing checks
 */

/** Sessions touched this recently are watched; older ones are left alone. */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const FRESH_MS = 60_000;

export function mountCiRoutes(
  app: Hono,
  opts: {
    broadcast: (event: string, data: unknown) => void;
    archive: (id: string) => Promise<void>;
  },
): PrWatch {
  const watch = createPrWatch({
    sessions: () => {
      const cutoff = Date.now() - RECENT_MS;
      return loadHistory()
        .filter((s) => !s.archivedAt && Date.parse(s.lastAccessedAt) >= cutoff && s.paths.some((p) => fs.existsSync(p)))
        .map((session) => ({ id: sessionIdFor(session), session }));
    },
    preflight: (s) => shipPreflight(s),
    reviewFeedback: (repoPath, n) => fetchReviewFeedback(repoPath, n, defaultRunner),
    archive: opts.archive,
    tell: async (id, body) => {
      await app.request(`/api/sessions/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'general', status: 'published', body }),
      });
    },
    broadcast: opts.broadcast,
    options: () => {
      const w = loadConfig()?.prWatch;
      return { autoArchive: w?.autoArchive !== false, fixCi: w?.fixCi !== false, reviewComments: w?.reviewComments !== false };
    },
    told: createSeenStores(),
  });

  app.get('/api/sessions/:id/ci', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const cached = watch.state(id);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < FRESH_MS) return c.json(cached);
    return c.json((await watch.refresh(id)) ?? { checkedAt: new Date().toISOString(), repos: [] });
  });

  app.post('/api/sessions/:id/ci/fix', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const sent = await watch.fixNow(id);
    return sent ? c.json({ ok: true }) : c.json({ error: 'no failing checks right now' }, 409);
  });

  return watch;
}
