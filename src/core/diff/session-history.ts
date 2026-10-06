import path from 'node:path';
import type { SessionCommit } from '../api-types.js';
import { git } from '../git/git.js';
import type { WorktreeSession } from '../sessions/history.js';
import { loadManifest } from './checkpoint.js';
import { computeRangeDiff } from './diff-pipeline.js';
import { rangeRefs, type DiffPoint } from './diff-points.js';
import { resolveRepoDiff } from './diff-scope.js';
import { scopeHashForPaths } from './scope-manager.js';
import type { ParsedFile } from './diff-parse.js';

/** More commits than this on one branch: the newest are listed. */
const MAX_COMMITS = 200;

/** Sessions' commit lists, by their repos' HEADs (and bases): one `rev-parse` per repo while nothing moved. */
const commitCache = new Map<string, SessionCommit[]>();
const COMMIT_CACHE_MAX = 50;

/**
 * Each repo's commits since the branch left its base (the "Since branch"
 * diff's merge-base), newest first: what the Diff tab's picker lists beside
 * the checkpoints. A repo with no base found lists none. A read: git log
 * only — and only when a HEAD moved: every open Diff tab asks after each
 * turn, and finding the base (parent detection, merge-base) is several git
 * runs per repo.
 */
export function sessionCommits(session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>): SessionCommit[] {
  const heads = session.paths.map((root) => git(['rev-parse', '--verify', '--quiet', 'HEAD'], root).stdout);
  const key = JSON.stringify([session.paths, heads, session.baseBranch ?? null, session.baseBranches ?? null]);
  const cached = commitCache.get(key);
  if (cached) return cached;
  const out: SessionCommit[] = [];
  for (const root of session.paths) {
    const { diffArg } = resolveRepoDiff(root, 'branch', session.baseBranches?.[root] ?? session.baseBranch);
    if (diffArg === 'HEAD') continue;
    const log = git(['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%cI%x1f%s', `${diffArg}..HEAD`, '--'], root);
    if (log.exitCode !== 0 || !log.stdout) continue;
    for (const line of log.stdout.split('\n')) {
      const [sha, at, subject] = line.split('\x1f');
      if (sha && at) out.push({ repo: path.basename(root), sha, at, subject: subject ?? '' });
    }
  }
  if (commitCache.size >= COMMIT_CACHE_MAX) commitCache.delete(commitCache.keys().next().value!);
  commitCache.set(key, out);
  return out;
}

export interface SessionRangeDiff {
  repos: Array<{ name: string; root: string; files: ParsedFile[] }>;
}

/** A session's diff between two points (`diff-points.ts`): checkpoints, commits, HEAD, the working tree. */
export function computeSessionRange(
  session: Pick<WorktreeSession, 'paths'>,
  from: DiffPoint,
  to: DiffPoint,
): SessionRangeDiff | { error: string } {
  // The manifest is keyed by the scope's paths, which are resolved: a stored path written
  // another way (slashes, a trailing separator) would miss every snapshot and read HEAD.
  const paths = session.paths.map((p) => path.resolve(p));
  const refs = rangeRefs(paths, loadManifest(scopeHashForPaths(paths)).entries, from, to);
  if ('error' in refs) return refs;
  return { repos: refs.map((r) => ({ name: r.name, root: r.root, files: computeRangeDiff(r) })) };
}
