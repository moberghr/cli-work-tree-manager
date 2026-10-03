import { withDb } from '../platform/db.js';

/**
 * What the PR watch has already acted on, per session: state.db's
 * `pr_watch_seen` (session_id, key). Keys are review-comment ids, per-PR
 * baselines, and CI head commits already reported (see pr-watch.ts /
 * pr-review.ts). Removed with the session (db.ts purgeSessionRows); no cap.
 *
 * No in-memory cache: each check is one primary-key lookup, and a cache
 * outlived the session it belonged to — a session removed and re-created
 * with the same target:branch inherited the old keys and had its review
 * comments and CI failures suppressed.
 */

/** A per-session seen-store. (Structurally the SeenStore of pr-review.ts —
 *  not imported, to keep the ship/history types out of an import cycle.) */
export function createSeenStores(): (sessionId: string) => { has: (k: string) => boolean; add: (k: string) => void } {
  return (sessionId) => ({
    has: (k) =>
      withDb((d) => d.prepare('SELECT 1 FROM pr_watch_seen WHERE session_id = ? AND key = ?').get(sessionId, k)) !== undefined,
    add: (k) => {
      try {
        withDb((d) => d.prepare('INSERT OR IGNORE INTO pr_watch_seen (session_id, key) VALUES (?, ?)').run(sessionId, k));
      } catch {
        /* best-effort: worst case something is reported twice */
      }
    },
  });
}
