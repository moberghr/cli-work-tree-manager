/**
 * PURE — keep it import-free (it is the policy; stack-sessions.ts applies it
 * to the session history, stack-sync.ts acts on it).
 *
 * Stacked sessions: one whose branch was made from another live session's
 * branch (a fork, or `work tree … --base feat/x`) is stacked on it — its
 * "main" is that branch until it merges. Nothing new is stored: the base a
 * session was made from is already recorded (`baseBranch` / `baseBranches`).
 * Behind and Update from (behind-main.ts) then measure against the parent,
 * and the parent's new commits are brought in (stack-sync.ts).
 */

export interface StackSubject {
  id: string;
  target: string;
  branch: string;
  baseBranch?: string;
  baseBranches?: Record<string, string>;
  archivedAt?: string | null;
}

/** Branches that are a project's mainline, never a parent to stack on. */
const LONG_LIVED = /^(main|master|dev|develop|development|staging|stage|production|prod|release|trunk)$/;

/** The one branch it was made from (a group: the same in every repo), or null. */
export function stackBase(s: Pick<StackSubject, 'baseBranch' | 'baseBranches'>): string | null {
  const per = s.baseBranches ? [...new Set(Object.values(s.baseBranches))] : [];
  const base = per.length === 1 ? per[0] : per.length === 0 ? (s.baseBranch ?? null) : null;
  return base && !LONG_LIVED.test(base) && !/^origin\//.test(base) ? base : null;
}

/**
 * The live session it is stacked on: same project, on the branch it was made
 * from. `eligible` leaves out what can't be a parent (the server: a repo's
 * own checkout, which a mainline-named base already excludes most of).
 */
export function stackParent<T extends StackSubject>(s: T, all: readonly T[], eligible: (p: T) => boolean = () => true): T | null {
  if (s.archivedAt) return null;
  const base = stackBase(s);
  if (!base || base === s.branch) return null;
  return all.find((p) => p.id !== s.id && !p.archivedAt && p.target === s.target && p.branch === base && eligible(p)) ?? null;
}

/**
 * Each session's parent, for a whole list at once. Sessions made from each
 * other's branches (A from B's, B from A's — possible with `--base`) form a
 * cycle, not a stack: none of them gets a parent, so nothing is brought back
 * and forth between them.
 */
export function stackParents<T extends StackSubject>(all: readonly T[], eligible?: (p: T) => boolean): Map<string, T> {
  const out = new Map<string, T>();
  for (const s of all) {
    const p = stackParent(s, all, eligible);
    if (p) out.set(s.id, p);
  }
  for (const id of [...out.keys()]) {
    const seen = new Set<string>([id]);
    for (let at = out.get(id); at; at = out.get(at.id)) {
      if (seen.has(at.id)) {
        for (const c of seen) out.delete(c);
        break;
      }
      seen.add(at.id);
    }
  }
  return out;
}

/**
 * The ARCHIVED session it was made from — its parent merged and is done, so
 * it should move onto main (stack-retarget.ts). Only one `merged` says merged:
 * an archived parent that never merged still holds work the child builds on,
 * and moving the child onto main would drop it. Null while a live session is
 * its parent, and for anything stackParent wouldn't count. The newest archive
 * when the branch name was used more than once.
 */
export function mergedParent<T extends StackSubject>(s: T, all: readonly T[], eligible: (p: T) => boolean = () => true, merged: (p: T) => boolean = () => false): T | null {
  if (s.archivedAt || stackParent(s, all, eligible)) return null;
  const base = stackBase(s);
  if (!base || base === s.branch) return null;
  const gone = all.filter((p) => p.id !== s.id && !!p.archivedAt && p.target === s.target && p.branch === base && eligible(p));
  const newest = gone.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))[0];
  return newest && merged(newest) ? newest : null;
}

/** How many live sessions are stacked on each session. */
export function stackChildCounts<T extends StackSubject>(parents: ReadonlyMap<string, T>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of parents.values()) out.set(p.id, (out.get(p.id) ?? 0) + 1);
  return out;
}
