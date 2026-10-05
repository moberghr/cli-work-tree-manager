import type { SessionSummary } from '../api/client.js';

/** One section of the grouped Sessions view — every session sharing a
 *  `work` target (a single repo alias or a multi-repo group name). */
export interface SessionGroup {
  key: string;
  /** True when the target is a multi-repo `work config group`. */
  isGroup: boolean;
  /** Member repos across the bucket's sessions (see groupRepoNames). */
  repos: string[];
  sessions: SessionSummary[];
}

/**
 * Bucket sessions by target. Sessions keep their input order inside each
 * bucket, so callers sort first. Buckets are ordered by first appearance
 * (i.e. the most-recent session's project first when sorted by recency),
 * or alphabetically when `alphabetical` is set.
 */
export function groupSessionsByTarget(sessions: SessionSummary[], alphabetical = false): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>();
  for (const s of sessions) {
    let g = byKey.get(s.target);
    if (!g) {
      g = { key: s.target, isGroup: s.isGroup, repos: [], sessions: [] };
      byKey.set(s.target, g);
    }
    g.sessions.push(s);
    // Union, first-seen order — sessions created before a repo was added
    // to the group still contribute what they have.
    for (const r of groupRepoNames(s)) {
      if (!g.repos.includes(r)) g.repos.push(r);
    }
  }
  const groups = [...byKey.values()];
  if (alphabetical) {
    groups.sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase()));
  }
  return groups;
}

/**
 * Repo names inside a multi-repo group session, taken from the worktree
 * paths (`<root>/<group>/<branch-dir>/<repoFolderName>`) — the same names
 * the diff view's repo tabs show. Empty for single-repo sessions, or when a
 * group only has one repo (nothing worth listing).
 */
export function groupRepoNames(session: SessionSummary): string[] {
  if (!session.isGroup || session.paths.length < 2) return [];
  return session.paths.map((p) => {
    const parts = p.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
  });
}
