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

/**
 * Each repo's commits since the branch left its base (the "Since branch"
 * diff's merge-base), newest first: what the Diff tab's picker lists beside
 * the checkpoints. A repo with no base found lists none. A read: git log
 * only.
 */
export function sessionCommits(session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>): SessionCommit[] {
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
  const refs = rangeRefs(session.paths, loadManifest(scopeHashForPaths(session.paths)).entries, from, to);
  if ('error' in refs) return refs;
  return { repos: refs.map((r) => ({ name: r.name, root: r.root, files: computeRangeDiff(r) })) };
}
