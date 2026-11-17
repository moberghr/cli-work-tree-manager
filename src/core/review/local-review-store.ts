import { json, withDb } from '../platform/db.js';
import type { PreparedLocal, StoredLocalReview } from './local-review.js';

/**
 * A session's own review, kept across restarts (reported: it lived in work web's memory, so a restart lost it and
 * cost minutes to prepare again): the last one prepared, with which of its notes you sent to the agent and which you
 * dismissed. One per session in state.db `session_reviews` (schema v14, gone with the session: purgeSessionRows).
 */

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A stored row is read as `unknown` and shape-checked (§5.5): one that isn't a review is no review. */
export function isStoredLocalReview(v: unknown): v is StoredLocalReview {
  const o = v as StoredLocalReview | null;
  if (!o || typeof o !== 'object') return false;
  const p = o.prepared as PreparedLocal | undefined;
  return (
    (o.repo === null || typeof o.repo === 'string') &&
    strings(o.repos) &&
    typeof o.at === 'string' &&
    strings(o.sent) &&
    strings(o.dismissed) &&
    !!p &&
    typeof p === 'object' &&
    Array.isArray(p.files) &&
    strings(p.repos) &&
    !!p.review &&
    typeof p.review === 'object' &&
    typeof p.review.headSha === 'string' &&
    Array.isArray(p.review.drafts) &&
    Array.isArray(p.review.stories) &&
    Array.isArray(p.review.files)
  );
}

export function readLocalReview(sessionId: string): StoredLocalReview | null {
  const row = withDb(
    (d) => d.prepare('SELECT data FROM session_reviews WHERE session_id = ?').get(sessionId) as { data: string } | undefined,
  );
  const v = row ? json.parse(row.data) : null;
  return isStoredLocalReview(v) ? v : null;
}

export function saveLocalReview(sessionId: string, review: StoredLocalReview): void {
  withDb((d) =>
    d.prepare('INSERT OR REPLACE INTO session_reviews (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(review)),
  );
}

export function dropLocalReview(sessionId: string): void {
  withDb((d) => d.prepare('DELETE FROM session_reviews WHERE session_id = ?').run(sessionId));
}
