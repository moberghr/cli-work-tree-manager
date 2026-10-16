import { json, withDb } from '../platform/db.js';
import type { SessionCi } from '../api-types.js';

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
    has: (k) => withDb((d) => d.prepare('SELECT 1 FROM pr_watch_seen WHERE session_id = ? AND key = ?').get(sessionId, k)) !== undefined,
    add: (k) => {
      try {
        withDb((d) => d.prepare('INSERT OR IGNORE INTO pr_watch_seen (session_id, key) VALUES (?, ?)').run(sessionId, k));
      } catch {
        /* best-effort: worst case something is reported twice */
      }
    },
  });
}

/**
 * The PR watch's last check of each session: state.db's `pr_watch_state`
 * (session_id, data), removed with the session. Kept so a restarted work web
 * shows each session's PRs at once rather than after its first sweep reaches
 * it (a minute or two with many sessions); that sweep then replaces it.
 */
export interface CiStore {
  load(): Array<[string, SessionCi]>;
  save(sessionId: string, ci: SessionCi): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED']);

/** A stored check as the watch wrote it (the fields its readers rely on); anything else is dropped. */
export function isSessionCi(v: unknown): v is SessionCi {
  if (!isObject(v) || typeof v.checkedAt !== 'string' || !Array.isArray(v.repos)) return false;
  return v.repos.every(
    (r) =>
      isObject(r) &&
      typeof r.name === 'string' &&
      typeof r.done === 'boolean' &&
      (r.pr === null ||
        (isObject(r.pr) &&
          typeof r.pr.number === 'number' &&
          typeof r.pr.url === 'string' &&
          typeof r.pr.state === 'string' &&
          PR_STATES.has(r.pr.state) &&
          typeof r.pr.headSha === 'string')) &&
      (r.openThreads === undefined || typeof r.openThreads === 'number') &&
      (r.threads === undefined || Array.isArray(r.threads)),
  );
}

export function createCiStore(): CiStore {
  return {
    load() {
      let rows: Array<{ session_id: string; data: string }>;
      try {
        rows = withDb((d) => d.prepare('SELECT session_id, data FROM pr_watch_state').all() as Array<{ session_id: string; data: string }>);
      } catch {
        return []; // best-effort, as saving is: the sweep fills it in
      }
      const out: Array<[string, SessionCi]> = [];
      for (const r of rows) {
        const ci = json.parse(r.data);
        if (isSessionCi(ci)) out.push([r.session_id, ci]);
      }
      return out;
    },
    save(sessionId, ci) {
      try {
        withDb((d) =>
          d.prepare('INSERT OR REPLACE INTO pr_watch_state (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(ci)),
        );
      } catch {
        /* best-effort: a restart then waits for the sweep, as before */
      }
    },
  };
}
