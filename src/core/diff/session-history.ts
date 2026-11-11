import path from 'node:path';
import type { SessionBranchSpan, SessionCommit } from '../api-types.js';
import { gitDirs, refShaFromFiles } from '../git/git-head.js';
import { runGitAsync } from './git-tree-snapshot.js';
import { branchStart } from '../git/reflog.js';
import type { WorktreeSession } from '../sessions/history.js';
import { repoNameOf, type SessionBranches } from '../sessions/session-branches.js';
import { loadManifest } from './checkpoint.js';
import { computeRangeDiff } from './diff-pipeline.js';
import { rangeRefs, type DiffPoint } from './diff-points.js';
import { resolveRepoDiffAsync } from './diff-scope.js';
import { scopeHashForPaths } from './scope-manager.js';
import type { ParsedFile } from './diff-parse.js';

/** More commits than this on one branch: the newest are listed. */
const MAX_COMMITS = 200;

/** Sessions' histories, by their repos' HEADs (and bases, and the other branches' tips), read from files: no git while nothing moved. */
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
 * The other branches the session worked on (session-branches.ts), per repo: every recorded branch but the one each
 * checkout is on now — merged and deleted ones too — the Diff shows everything the session worked on — the last
 * checked out first, at most MAX_HISTORY_BRANCHES per repo. `current`: what each checkout is on now (HEAD files;
 * a rebase's branch, `workingBranch`). Detached otherwise, the branch it was on last stands for it: its own work
 * isn't another branch's. Pure.
 */
export function historyBranchRefs(
  session: Pick<WorktreeSession, 'paths' | 'isGroup' | 'target'>,
  rec: SessionBranches | null | undefined,
  current: (checkout: string) => string | null,
): OtherBranchRef[] {
  return session.paths.flatMap((p) => {
    const repo = repoNameOf(session, p);
    const mine = (rec?.branches ?? []).filter((b) => b.repo === repo).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const now = current(p) ?? mine[0]?.name ?? null;
    return mine
      .filter((b) => b.name !== now)
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

/** git off the event loop: its output trimmed, and whether it worked. */
async function g(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const r = await runGitAsync(cwd, { args });
  return { ok: r.status === 0, out: r.stdout.trim() };
}

/** What a session's history is keyed by: each repo's HEAD and each other branch's tip, read from files (no git). */
function historyKey(session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>, others: OtherBranchRef[]): string | null {
  const heads = session.paths.map((root) => refShaFromFiles(root, 'HEAD'));
  const tips = others.map((b) => refShaFromFiles(b.path, `refs/heads/${b.name}`) ?? `gone:${b.tip ?? ''}`);
  // A HEAD the files can't say (an unusual ref layout): no key, so it's worked out again rather than kept stale.
  if (heads.some((h) => !h)) return null;
  return JSON.stringify([session.paths, heads, session.baseBranch ?? null, session.baseBranches ?? null, others, tips]);
}

/**
 * Each repo's commits since the branch left its base (the "Since branch"
 * diff's merge-base), newest first: what the Diff tab's picker lists beside
 * the checkpoints. A repo with no base found lists none. A read, off the event
 * loop, and only when a HEAD or a branch moved: while nothing did, the answer
 * is kept, looked up by what the repos' files say (no git at all) — every
 * open Diff tab asks after each turn.
 *
 * `others`: the other branches the session worked on (historyBranchRefs).
 * Each lists its own work, marked with its `branch`, merged or not: from
 * where its own work begins (its reflog, else the start kept for it) to its
 * tip (its branch, or the tip recorded once it is deleted), along its own
 * line (`--first-parent`: a merge of its base into it is one commit, not all
 * of the base's). Its whole work is a span: from the last base it took in
 * (the newest such merge's other parent), else from where it began, to its
 * tip — one with no commits of its own too (base = tip), so the turns taken
 * on it are diffed from the commit it was at, not from another branch's
 * turn. A branch with no start known: its commits that neither HEAD, the main
 * line nor what it was made from has, as before, the span from the parent of
 * the oldest of them all (not only of those listed).
 */
export async function sessionHistory(
  session: Pick<WorktreeSession, 'paths' | 'baseBranch' | 'baseBranches'>,
  others: OtherBranchRef[] = [],
): Promise<SessionHistory> {
  const key = historyKey(session, others);
  const cached = key ? historyCache.get(key) : undefined;
  if (cached) return cached;
  const commits: SessionCommit[] = [];
  const spans: SessionBranchSpan[] = [];
  for (const root of session.paths) {
    // Off the event loop too: finding its base walks merge-bases, which take a while on a big repo.
    const { diffArg } = await resolveRepoDiffAsync('branch', session.baseBranches?.[root] ?? session.baseBranch, async (args) => {
      const r = await g(args, root);
      return { exitCode: r.ok ? 0 : 1, stdout: r.out };
    });
    if (diffArg === 'HEAD') continue;
    const log = await g(['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%cI%x1f%s', `${diffArg}..HEAD`, '--'], root);
    if (log.ok && log.out) commits.push(...parseLog(log.out, path.basename(root)));
  }
  for (const b of others) {
    const tip = await tipOf(b);
    if (!tip) continue; // deleted, and its tip unknown or gone from the repo: nothing to list
    const repo = path.basename(b.path);
    // The branch's reflog while it is there (a rebase since moves where its work begins), else what was kept.
    const start = liveStart(b) ?? b.start;
    let list: SessionCommit[] = [];
    let base: string | null;
    if (start && (await g(['merge-base', '--is-ancestor', start, tip], b.path)).ok) {
      const log = await g(
        ['log', '--first-parent', `-n${MAX_OTHER_COMMITS}`, '--format=%H%x1f%cI%x1f%s', `${start}..${tip}`, '--'],
        b.path,
      );
      if (log.ok && log.out) list = parseLog(log.out, repo);
      base = (await lastBaseTakenIn(b.path, start, tip)) ?? start;
    } else {
      // Its own commits: not on what's checked out, not on the main line, not on what it was made from.
      const not: string[] = [];
      for (const ref of ['HEAD', 'origin/HEAD', ...(b.from ? [b.from] : [])])
        if ((await g(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], b.path)).ok) not.push(ref);
      const log = await g(['log', `-n${MAX_OTHER_COMMITS}`, '--format=%H%x1f%cI%x1f%s', tip, '--not', ...not, '--'], b.path);
      if (log.ok && log.out) list = parseLog(log.out, repo);
      // The oldest of ALL its own commits, not of the newest listed: "All of it" is its whole work.
      const oldest =
        list.length < MAX_OTHER_COMMITS
          ? list[list.length - 1]?.sha
          : (await g(['rev-list', '--reverse', tip, '--not', ...not, '--'], b.path)).out.split('\n')[0];
      base = oldest ? (await g(['rev-parse', '--verify', '--quiet', `${oldest}^`], b.path)).out || null : tip;
    }
    commits.push(...list.map((c) => ({ ...c, branch: b.name })));
    if (base) spans.push({ repo, branch: b.name, base, tip });
  }
  const out = { commits, spans };
  if (key) {
    if (historyCache.size >= HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!);
    historyCache.set(key, out);
  }
  return out;
}

/** How many of a branch's merges are looked at for the last base it took in (newest first). */
const MAX_MERGES_LOOKED_AT = 20;

/**
 * The last base a branch took in: the other parent of its newest first-parent merge that brought in none of its own
 * line — a merge of dev into it. A merge of its own copy (`git pull --no-ff` of origin/<name>) or of a branch made
 * from it already holds its earlier commits, and "All of it" from there would show only what came after: such a
 * merge is passed over for an older one. Null: none took in a base (its span starts where its work began).
 */
async function lastBaseTakenIn(repo: string, start: string, tip: string): Promise<string | null> {
  const merges = (await g(['rev-list', '--first-parent', '--merges', `-n${MAX_MERGES_LOOKED_AT}`, `${start}..${tip}`], repo)).out;
  for (const merge of merges.split('\n').filter(Boolean)) {
    const other = (await g(['rev-parse', '--verify', '--quiet', `${merge}^2`], repo)).out;
    if (!other) continue;
    // Its own line up to the merge, and how much of it the merged side doesn't have: all of it → a base.
    const own = (await g(['rev-list', '--first-parent', '--count', `${merge}^1`, `^${start}`], repo)).out;
    const notThere = (await g(['rev-list', '--first-parent', '--count', `${merge}^1`, `^${start}`, `^${other}`], repo)).out;
    if (own && own === notThere) return other;
  }
  return null;
}

/** A branch's tip: the branch, else (deleted) the tip recorded while it was there, while the repo still has it. */
async function tipOf(b: OtherBranchRef): Promise<string | null> {
  const live =
    refShaFromFiles(b.path, `refs/heads/${b.name}`) ??
    (await g(['rev-parse', '--verify', '--quiet', `refs/heads/${b.name}^{commit}`], b.path)).out;
  if (live) return live;
  if (!b.tip) return null;
  return (await g(['cat-file', '-e', `${b.tip}^{commit}`], b.path)).ok ? b.tip : null;
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
