import { withDb } from './db.js';

/**
 * What the PR watch has already acted on, per session: state.db's
 * `pr_watch_seen` (session_id, key). Keys are review-comment ids, per-PR
 * baselines, and CI head commits already reported (see pr-watch.ts /
 * pr-review.ts). Removed with the session (db.ts purgeSessionRows); no cap.
 */

/** A per-session seen-store factory, cached in memory. (Structurally the
 *  SeenStore of pr-review.ts — not imported, to keep the ship/history
 *  types out of an import cycle.) */
export function createSeenStores(): (sessionId: string) => { has: (k: string) => boolean; add: (k: string) => void } {
  const cache = new Map<string, Set<string>>();
  return (sessionId) => {
    let set = cache.get(sessionId);
    if (!set) {
      set = new Set(
        withDb((d) =>
          (d.prepare('SELECT key FROM pr_watch_seen WHERE session_id = ?').all(sessionId) as Array<{ key: string }>).map((r) => r.key),
        ),
      );
      cache.set(sessionId, set);
    }
    const keys = set;
    return {
      has: (k) => keys.has(k),
      add: (k) => {
        if (keys.has(k)) return;
        keys.add(k);
        try {
          withDb((d) => d.prepare('INSERT OR IGNORE INTO pr_watch_seen (session_id, key) VALUES (?, ?)').run(sessionId, k));
        } catch {
          /* best-effort: worst case something is reported twice */
        }
      },
    };
  };
}
