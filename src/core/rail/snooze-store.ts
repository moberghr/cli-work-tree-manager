import { json, withDb } from '../platform/db.js';
import type { PrStageKind } from '../pr/pr-stage.js';
import { snoozeFor, snoozeUntil, type Snooze } from './snooze.js';
import { readStatus } from '../status/session-status.js';

/** Snoozes, one per session, in state.db `session_snooze` (gone with the session: purgeSessionRows). */

function isSnooze(v: unknown): v is Snooze {
  const o = v as Snooze | null;
  return !!o && typeof o === 'object' && (o.until === null || typeof o.until === 'string') && typeof o.at === 'string';
}

export function readSnooze(sessionId: string): Snooze | null {
  const row = withDb(
    (d) => d.prepare('SELECT data FROM session_snooze WHERE session_id = ?').get(sessionId) as { data: string } | undefined,
  );
  const v = row ? json.parse(row.data) : null;
  return isSnooze(v) ? v : null;
}

/** Every session's snooze (one query for the whole session list). */
export function allSnoozes(): Map<string, Snooze> {
  const rows = withDb((d) => d.prepare('SELECT session_id, data FROM session_snooze').all() as Array<{ session_id: string; data: string }>);
  const out = new Map<string, Snooze>();
  for (const r of rows) {
    const v = json.parse(r.data);
    if (isSnooze(v)) out.set(r.session_id, v);
  }
  return out;
}

export function saveSnooze(sessionId: string, snooze: Snooze): void {
  withDb((d) => d.prepare('INSERT OR REPLACE INTO session_snooze (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(snooze)));
}

export function clearSnooze(sessionId: string): boolean {
  return withDb((d) => d.prepare('DELETE FROM session_snooze WHERE session_id = ?').run(sessionId).changes > 0);
}

/** A snooze asked for: one of the choices, or until a time. */
export type SnoozeRequest = { for: '2h' | 'tomorrow' | 'change' } | { until: string };

/** Validate a request body as one; null when it isn't. */
export function cleanSnoozeRequest(raw: unknown): SnoozeRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (o.for === '2h' || o.for === 'tomorrow' || o.for === 'change') return { for: o.for };
  if (typeof o.until === 'string' && o.until) return { until: o.until };
  return null;
}

/**
 * Snooze a session — the dashboard's menu and `work snooze` both. "Until it
 * changes" is taken against the status the hooks recorded (and the review
 * threads the caller knows of), as the check that ends it compares.
 */
export function requestSnooze(
  sessionId: string,
  req: SnoozeRequest,
  shown: { openReviewThreads?: number; prStage?: { kind: PrStageKind; key: string } | null } = {},
  now = new Date(),
): { ok: true; snooze: Snooze } | { ok: false; error: string } {
  const snooze =
    'until' in req
      ? snoozeUntil(req.until, now)
      : snoozeFor(
          req.for,
          { attention: readStatus(sessionId), openReviewThreads: shown.openReviewThreads ?? 0, prStage: shown.prStage },
          now,
        );
  if (!snooze) return { ok: false, error: 'not a time to snooze until: give one in the next 30 days' };
  saveSnooze(sessionId, snooze);
  return { ok: true, snooze };
}
