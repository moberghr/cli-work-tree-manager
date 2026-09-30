import fs from 'node:fs';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createSeenStores } from './pr-watch-store.js';
import { loadHistory } from './history.js';
import { sessionIdFor } from './session-id.js';
import { findSession } from './web-state.js';
import { defaultRunner, shipPreflight } from './ship.js';
import { fetchReviewFeedback } from './pr-review.js';
import { dbPtySessions } from './pty-sessions-file.js';
import { readStatus } from './session-status.js';
import { createPrWatch, type PrWatch } from './pr-watch.js';
import type { ActivityLog } from './activity.js';
import type { WakeResult } from './pr-watch.js';
import { rememberSent } from './pr-replies.js';
import { readContextUsage } from './context-usage.js';
import { ensurePty, peekPty, ptyPids } from './pty-pool.js';
import { claudesBySession, readLiveClaudes } from './live-claudes.js';

/** The first message of a Claude started for a PR note: the note itself
 *  rides along (the UserPromptSubmit hook adds pending comments). */
export const WAKE_PROMPT =
  'work just sent you new feedback on your pull request (it is attached to this message). Work through it now.';

/**
 * A note was just queued for the session's Claude. If that Claude isn't
 * running anywhere, start it in the PTY host — resuming its conversation,
 * with WAKE_PROMPT — so it works on the note now instead of whenever you
 * next open the session. A Claude already running (here or in a terminal)
 * gets the note from the comment path. Config `prWatch.wakeClaude: false`
 * turns this off.
 */
async function wakeForNote(id: string): Promise<WakeResult> {
  if (loadConfig()?.prWatch?.wakeClaude === false) return 'off';
  if (peekPty(id)) return 'running';
  const hostPids = ptyPids();
  const elsewhere = (claudesBySession(readLiveClaudes(), loadHistory()).get(id) ?? []).filter((c) => !hostPids.has(c.pid));
  if (elsewhere.length) return 'running';
  const url = await ensurePty(id, { initialPrompt: WAKE_PROMPT }).catch(() => null);
  return url ? 'started' : 'failed';
}

/**
 * The PR watch (pr-watch.ts) wired to real sessions, gh and the comment
 * route, plus its endpoints:
 *
 *   GET  /api/sessions/:id/ci      cached CI/PR state (re-checked if > 60 s old)
 *   POST /api/sessions/:id/ci/fix  tell the session's Claude to fix failing checks
 */

// Sessions checked: used in the last 30 days (a PR is often merged days after
// you last touched the session — that is when it should archive itself).
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const FRESH_MS = 60_000;

export function mountCiRoutes(
  app: Hono,
  opts: {
    broadcast: (event: string, data: unknown) => void;
    archive: (id: string) => Promise<void>;
    activity?: ActivityLog;
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
    runsUnsafe: (id) => dbPtySessions.read()[id]?.unsafe === true,
    ...(opts.activity ? { activity: opts.activity } : {}),
    busy: (id) => {
      const st = readStatus(id)?.state;
      return st === 'working' || st === 'needs_input';
    },
    archive: opts.archive,
    tell: async (id, body) => {
      const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'general', status: 'published', body }),
      });
      // A failed post must surface, so the watch doesn't record it as told.
      if (!res.ok) throw new Error(`posting the note failed: ${res.status}`);
    },
    broadcast: opts.broadcast,
    options: () => {
      const w = loadConfig()?.prWatch;
      return {
        autoArchive: w?.autoArchive !== false,
        fixCi: w?.fixCi !== false,
        reviewComments: w?.reviewComments !== false,
        ...(w?.trustedBots ? { trustedBots: w.trustedBots } : {}),
      };
    },
    rememberThreads: (id, threads) => {
      rememberSent(id, threads);
      opts.broadcast('replies-changed', { sessionId: id });
    },
    wake: (id) => wakeForNote(id),
    contextShare: (s) => {
      const u = readContextUsage(s);
      return u && u.window > 0 ? u.used / u.window : null;
    },
    told: createSeenStores(),
  });

  app.get('/api/sessions/:id/ci', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const cached = watch.state(id);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < FRESH_MS) return c.json(cached);
    // Report only: a GET must not post notes to Claude or archive (the
    // sweep and POST …/ci/fix do the acting).
    return c.json((await watch.refresh(id, { act: false })) ?? { checkedAt: new Date().toISOString(), repos: [] });
  });

  app.post('/api/sessions/:id/ci/fix', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const sent = await watch.fixNow(id);
    return sent ? c.json({ ok: true }) : c.json({ error: 'no failing checks right now' }, 409);
  });

  return watch;
}
