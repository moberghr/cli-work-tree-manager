/**
 * The points in a session's history the Diff tab diffs between: a checkpoint
 * (every repo's tree at the end of a turn — Claude's uncommitted work
 * included), a commit of one repo, that commit's parent, the repo's HEAD, or
 * the working tree. Any two make a range, so commits and turns can be mixed:
 * "from this commit to the last turn".
 *
 * On the wire (`GET /api/sessions/:id/diff?from=&to=`): `cp:3` (a bare `3`
 * too, as before), `c:<repo>:<sha>`, `p:<repo>:<sha>` (the commit's parent),
 * `head`, `working`. Pure: the demo and the SPA use it as well.
 */
export type DiffPoint =
  | { kind: 'checkpoint'; id: number }
  | { kind: 'commit'; repo: string; sha: string }
  | { kind: 'parent'; repo: string; sha: string }
  | { kind: 'head' }
  | { kind: 'working' };

/** A full or abbreviated object name: the only thing a commit point may carry to git. */
const SHA = /^[0-9a-f]{7,40}$/;
/** A repo's name as the session's tabs show it (its folder): no separator, nothing git could read as an option. */
const REPO = /^[^:/\\\s-][^:/\\\s]*$/;

export function parsePoint(raw: string | undefined | null): DiffPoint | null {
  if (!raw) return null;
  if (raw === 'working') return { kind: 'working' };
  if (raw === 'head') return { kind: 'head' };
  const cp = /^(?:cp:)?(\d+)$/.exec(raw);
  if (cp) return { kind: 'checkpoint', id: Number(cp[1]) };
  const m = /^([cp]):([^:]+):([^:]+)$/.exec(raw);
  if (!m || !REPO.test(m[2]) || !SHA.test(m[3])) return null;
  return { kind: m[1] === 'c' ? 'commit' : 'parent', repo: m[2], sha: m[3] };
}

export function pointParam(p: DiffPoint): string {
  switch (p.kind) {
    case 'working':
      return 'working';
    case 'head':
      return 'head';
    case 'checkpoint':
      return `cp:${p.id}`;
    case 'commit':
      return `c:${p.repo}:${p.sha}`;
    case 'parent':
      return `p:${p.repo}:${p.sha}`;
  }
}

export const samePoint = (a: DiffPoint, b: DiffPoint): boolean => pointParam(a) === pointParam(b);

/** What `rangeRefs` needs of a checkpoint: its id, and each repo's snapshot commit (keyed by path, or name in the demo). */
export interface PointCheckpoint {
  id: number;
  repos: Record<string, string | null>;
}

/** One repo's side of a range: the refs `computeRangeDiff` takes. */
export interface RangeRepo {
  name: string;
  root: string;
  fromRef: string;
  toRef: string | 'working';
}

const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Per repo, the two refs a range diffs. A commit belongs to one repo, so a
 * range with a commit at either end is that repo's alone; checkpoints, HEAD
 * and the working tree cover every repo. A checkpoint with no snapshot for a
 * repo reads as its HEAD (as the scope route does).
 */
export function rangeRefs(
  paths: readonly string[],
  checkpoints: readonly PointCheckpoint[],
  from: DiffPoint,
  to: DiffPoint,
): RangeRepo[] | { error: string } {
  if (from.kind === 'working') return { error: "'working' can only end a range" };
  const repoOf = (p: DiffPoint) => (p.kind === 'commit' || p.kind === 'parent' ? p.repo : null);
  const fromRepo = repoOf(from);
  const toRepo = repoOf(to);
  if (fromRepo && toRepo && fromRepo !== toRepo) return { error: 'a range of commits stays within one repo' };
  const only = fromRepo ?? toRepo;
  if (only && !paths.some((p) => nameOf(p) === only)) return { error: `unknown repo ${only}` };
  for (const p of [from, to]) {
    if (p.kind === 'checkpoint' && !checkpoints.some((c) => c.id === p.id)) return { error: `unknown checkpoint ${p.id}` };
  }
  if (from.kind === 'checkpoint' && to.kind === 'checkpoint' && to.id < from.id) {
    return { error: `to (${to.id}) must be >= from (${from.id})` };
  }
  const refIn = (p: DiffPoint, root: string): string => {
    switch (p.kind) {
      case 'checkpoint': {
        const c = checkpoints.find((x) => x.id === p.id);
        return c?.repos[root] ?? c?.repos[nameOf(root)] ?? 'HEAD';
      }
      case 'commit':
        return p.sha;
      case 'parent':
        return `${p.sha}^`;
      case 'head':
      case 'working':
        return 'HEAD';
    }
  };
  return paths
    .filter((root) => !only || nameOf(root) === only)
    .map((root) => ({
      name: nameOf(root),
      root,
      fromRef: refIn(from, root),
      toRef: to.kind === 'working' ? 'working' : refIn(to, root),
    }));
}
