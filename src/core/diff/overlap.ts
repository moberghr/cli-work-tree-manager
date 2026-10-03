import type { SessionOverlap } from '../api-types.js';

/**
 * Two sessions that change the same file of the same repository will
 * conflict at merge time — find out while both are still in progress, not
 * in the Ship dialog. Pure: the per-session file sets come from the diff
 * stat cache (diff-stat.ts), which runs the git.
 */

/** Files one session touches in one repository. */
export interface TouchedRepo {
  /** The repository's identity: its shared git dir (`--git-common-dir`),
   *  the same for every worktree of one repo. */
  repoKey: string;
  /** Repo alias, for display. */
  name: string;
  /** Root-relative paths: committed on the branch since it forked, plus
   *  uncommitted and untracked changes. */
  files: string[];
}

export interface SessionFiles {
  id: string;
  target: string;
  branch: string;
  touched: TouchedRepo[];
}

/** Cap per pair, so a big refactor doesn't bloat every session row. */
export const MAX_OVERLAP_FILES = 20;

/**
 * For each session, the other sessions it shares changed files with (same
 * repo, same path), most overlapping first. Sessions without overlaps are
 * absent from the map.
 */
export function findOverlaps(sessions: SessionFiles[]): Map<string, SessionOverlap[]> {
  // repoKey → file → the sessions touching it
  const index = new Map<string, Map<string, Set<number>>>();
  sessions.forEach((s, i) => {
    for (const r of s.touched) {
      let files = index.get(r.repoKey);
      if (!files) index.set(r.repoKey, (files = new Map()));
      for (const f of r.files) {
        let who = files.get(f);
        if (!who) files.set(f, (who = new Set()));
        who.add(i);
      }
    }
  });

  // pair "i:j" (i < j) → shared "repo/path" entries
  const shared = new Map<string, Array<{ repo: string; path: string }>>();
  for (const [repoKey, files] of index) {
    for (const [file, who] of files) {
      if (who.size < 2) continue;
      const ids = [...who].sort((a, b) => a - b);
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const key = `${ids[a]}:${ids[b]}`;
          const name = sessions[ids[a]].touched.find((r) => r.repoKey === repoKey)?.name ?? '';
          let list = shared.get(key);
          if (!list) shared.set(key, (list = []));
          list.push({ repo: name, path: file });
        }
      }
    }
  }

  const out = new Map<string, SessionOverlap[]>();
  const add = (self: number, other: number, files: Array<{ repo: string; path: string }>) => {
    const o = sessions[other];
    const list = out.get(sessions[self].id) ?? [];
    list.push({
      sessionId: o.id,
      target: o.target,
      branch: o.branch,
      count: files.length,
      files: files.slice(0, MAX_OVERLAP_FILES),
    });
    out.set(sessions[self].id, list);
  };
  for (const [key, files] of shared) {
    const [a, b] = key.split(':').map(Number);
    files.sort((x, y) => x.repo.localeCompare(y.repo) || x.path.localeCompare(y.path));
    add(a, b, files);
    add(b, a, files);
  }
  for (const list of out.values()) list.sort((x, y) => y.count - x.count || x.branch.localeCompare(y.branch));
  return out;
}
