import path from 'node:path';
import type { SessionBranchSpan, SessionCommit } from '../api-types.js';
import { git } from '../git/git.js';
import { gitDirs } from '../git/git-head.js';
import { branchStart } from '../git/reflog.js';
import type { WorktreeSession } from '../sessions/history.js';
import { repoNameOf, type SessionBranches } from '../sessions/session-branches.js';
import { loadManifest } from './checkpoint.js';
import { computeRangeDiff } from './diff-pipeline.js';
import { rangeRefs, type DiffPoint } from './diff-points.js';
import { resolveRepoDiff } from './diff-scope.js';
import { scopeHashForPaths } from './scope-manager.js';
import type { ParsedFile } from './diff-parse.js';

/** More commits than this on one branch: the newest are listed. */
const MAX_COMMITS = 200;

/** Sessions' histories, by their repos' HEADs (and bases, and the other branches' tips): one `rev-parse` per repo while nothing moved. */
const historyCache = new Map<string, SessionHistory>();
const HISTORY_CACHE_MAX = 50;
/** Most commits listed for another branch: the newest. */
const MAX_OTHER_COMMITS = 50;
/** Most other branches listed per repo: the ones last checked out. */
export const MAX_HISTORY_BRANCHES = 10;

/** Another branch of one of the session's repos (session-branches.ts), and what is known of where it began and ended. */
export interface OtherBranchRef {
  /** The repo's checkout (one of the session's paths). */
  path: string;
  name: string;
  from?: string;
  /** The commit it was made at (its reflog's first line, kept in the record). */
  start?: string;
  /** Its tip when last looked at: what it is once deleted. */
  tip?: string;
}

/**
 * Every other branch the session's repos were on (session-branches.ts), for the Diff tab: all of them, merged
 * and deleted ones too — the Diff shows everything the session worked on — the last checked out first, at most
 * MAX_HISTORY_BRANCHES per repo. `current`: what each checkout has checked out now (HEAD files). Pure.
 */
export function historyBranchRefs(
  session: Pick<WorktreeSession, 'paths' | 'isGroup' | 'target'>,
  rec: SessionBranches | null | undefined,
  current: (checkout: string) => string | null,
): OtherBranchRef[] {
  return session.paths.flatMap((p) => {
    const repo = repoNameOf(session, p);
    const now = current(p);
    return (rec?.branches ?? [])
      .filter((b) => b.repo === repo && b.name !== now)
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .slice(0, MAX_HISTORY_BRANCHES)
      .map((b) => ({
        path: p,
        name: b.name,
        ...(b.from ? { from: b.from } : {}),
        ...(b.start ? { start: b.start } : {}),
        ...(b.tip ? { tip: b.tip } : {}),
      }));
  });
}

export interface SessionHistory {
  commits: SessionCommit[];
  /** Each other branch's whole work, as two commits to diff between (its base and its tip). */
  spans: SessionBranchSpan[];
}

/**
 * Each repo's commits since the branch left its base (the "Since branch"
 * diff's merge-base), newest first: what the Diff tab's picker lists beside
 * the checkpoints. A repo with no base found lists none. A read: git log
 * only — and only when a HEAD moved: every open Diff tab asks after each
 * turn, and finding the base (parent detection, merge-base) is several git
 * runs per repo.
 *
 * `others`: the other branches the session worked on (historyBranchRefs).
 * Each lists its own work, marked with its `branch`, merged or not: from the
 * commit it was made at to its tip (its branch, or the tip recorded once it
 * is deleted), along its own line (`--first-parent`: a merge of its base into
 * it is one commit, not all of the base's). Its whole work is a span: from
 * the last base it took in (the newest such merge's other parent), else from
 * where it was made, to its tip. A branch with no start known: its commits
 * that neither HEAD, the main line nor what it was made from has, as before.
 */
export function sessionHistory(
  session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>,
  others: OtherBranchRef[] = [],
): SessionHistory {
  const heads = session.paths.map((root) => git(['rev-parse', '--verify', '--quiet', 'HEAD'], root).stdout);
  const tips = others.map((b) => tipOf(b));
  const key = JSON.stringify([session.paths, heads, session.baseBranch ?? null, session.baseBranches ?? null, others, tips]);
  const cached = historyCache.get(key);
  if (cached) return cached;
  const commits: SessionCommit[] = [];
  const spans: SessionBranchSpan[] = [];
  for (const root of session.paths) {
    const { diffArg } = resolveRepoDiff(root, 'branch', session.baseBranches?.[root] ?? session.baseBranch);
    if (diffArg === 'HEAD') continue;
    const log = git(['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%cI%x1f%s', `${diffArg}..HEAD`, '--'], root);
    if (log.exitCode !== 0 || !log.stdout) continue;
    commits.push(...parseLog(log.stdout, path.basename(root)));
  }
  others.forEach((b, i) => {
    const tip = tips[i];
    if (!tip) return; // deleted, and its tip unknown or gone from the repo: nothing to list
    const repo = path.basename(b.path);
    // The branch's reflog while it is there (a rebase since moves where its work begins), else what was kept.
    const start = liveStart(b) ?? b.start;
    let list: SessionCommit[] = [];
    let base: string | null;
    if (start && git(['merge-base', '--is-ancestor', start, tip], b.path).exitCode === 0) {
      const log = git(['log', '--first-parent', `-n${MAX_OTHER_COMMITS}`, '--format=%H%x1f%cI%x1f%s', `${start}..${tip}`, '--'], b.path);
      if (log.exitCode === 0 && log.stdout) list = parseLog(log.stdout, repo);
      const merge = git(['rev-list', '--first-parent', '--merges', '-n1', `${start}..${tip}`], b.path).stdout;
      base = (merge && git(['rev-parse', '--verify', '--quiet', `${merge}^2`], b.path).stdout) || start;
    } else {
      // Its own commits: not on what's checked out, not on the main line, not on what it was made from.
      const not = ['HEAD', 'origin/HEAD', ...(b.from ? [b.from] : [])].filter(
        (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], b.path).exitCode === 0,
      );
      const log = git(['log', `-n${MAX_OTHER_COMMITS}`, '--format=%H%x1f%cI%x1f%s', tip, '--not', ...not, '--'], b.path);
      if (log.exitCode === 0 && log.stdout) list = parseLog(log.stdout, repo);
      const oldest = list[list.length - 1];
      base = oldest ? git(['rev-parse', '--verify', '--quiet', `${oldest.sha}^`], b.path).stdout || null : null;
    }
    commits.push(...list.map((c) => ({ ...c, branch: b.name })));
    if (base && base !== tip) spans.push({ repo, branch: b.name, base, tip });
  });
  const out = { commits, spans };
  if (historyCache.size >= HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!);
  historyCache.set(key, out);
  return out;
}

/** The commits the picker lists (sessionHistory's). */
export function sessionCommits(
  session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>,
  others: OtherBranchRef[] = [],
): SessionCommit[] {
  return sessionHistory(session, others).commits;
}

/** A branch's tip: the branch, else (deleted) the tip recorded while it was there, while the repo still has it. */
function tipOf(b: OtherBranchRef): string | null {
  const live = git(['rev-parse', '--verify', '--quiet', `refs/heads/${b.name}^{commit}`], b.path).stdout;
  if (live) return live;
  if (!b.tip) return null;
  return git(['rev-parse', '--verify', '--quiet', `${b.tip}^{commit}`], b.path).exitCode === 0 ? b.tip : null;
}

/** Where a branch's own work begins, from its reflog, while it is there. */
function liveStart(b: OtherBranchRef): string | null {
  const dirs = gitDirs(b.path);
  return dirs ? branchStart(dirs.commonDir, b.name) : null;
}

function parseLog(stdout: string, repo: string): SessionCommit[] {
  const out: SessionCommit[] = [];
  for (const line of stdout.split('\n')) {
    const [sha, at, subject] = line.split('\x1f');
    if (sha && at) out.push({ repo, sha, at, subject: subject ?? '' });
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
  // The manifest is keyed by the scope's paths, which are resolved: a stored path written
  // another way (slashes, a trailing separator) would miss every snapshot and read HEAD.
  const paths = session.paths.map((p) => path.resolve(p));
  const refs = rangeRefs(paths, loadManifest(scopeHashForPaths(paths)).entries, from, to);
  if ('error' in refs) return refs;
  return { repos: refs.map((r) => ({ name: r.name, root: r.root, files: computeRangeDiff(r) })) };
}
