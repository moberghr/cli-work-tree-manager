import path from 'node:path';
import { defaultRunner, type CommandRunner } from '../platform/command-runner.js';
import type { WorktreeSession } from '../sessions/history.js';
import { DEFAULT_HOST, hostForRepo } from '../hosts/index.js';
import type { MergeMethod, MergeSelection, RepoShipState, ShipPr, ShipPreflight, ShipResult } from '../api-types.js';

export { defaultRunner, type CommandRunner, type RunResult } from '../platform/command-runner.js';
export type {
  ChecksState,
  MergeMethod,
  MergeSelection,
  RepoShipState,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipResult,
} from '../api-types.js';

/**
 * Ship a session's work: push, open a PR, merge it — per repo, because a
 * group's repos ship independently: backend can be merged and done while
 * frontend still waits for review.
 *
 * Group rules (the careful part):
 *   - A repo whose PR is MERGED, or that was never touched (no commits vs
 *     the base, clean, no PR), is `done` — never a blocker for the others.
 *   - Merge takes an explicit list of repos, each with the PR head SHA the
 *     user was shown. The server re-checks every one of them and merges
 *     NONE if any is blocked or its PR moved; repos not listed are left
 *     alone. So a group can be shipped in parts, deliberately.
 *   - The session is archived only when a merge actually merged something
 *     AND every repo is done afterwards.
 *
 * Every git/gh call goes through a `CommandRunner` with an argv array — no
 * shell (§1.1) — injectable so the decision logic is unit-testable.
 */

/** The repos a session ships: each worktree path, named by its folder. */
export function shipRepos(session: WorktreeSession): Array<{ name: string; path: string }> {
  return session.paths.map((p) => ({
    name: session.isGroup ? path.basename(p) : session.target,
    path: p,
  }));
}

type RepoFacts = Omit<RepoShipState, 'mergeBlockers' | 'done' | 'doneReason'>;

/**
 * The checked-out commit is in its merged PR: the PR's head, or behind it on
 * the same line (the PR got commits on GitHub the worktree never pulled). A
 * commit after the head, or on another line, is work the merge didn't take.
 */
export function checkedOutMerged(r: Pick<RepoFacts, 'localSha' | 'behindMergedHead' | 'pr'>): boolean {
  return !r.localSha || r.localSha === r.pr?.headSha || r.behindMergedHead === true;
}

/** Done = nothing left to ship from this repo. */
export function repoDone(r: RepoFacts): { done: boolean; reason?: 'merged' | 'untouched' } {
  // Merged AND nothing since: a follow-up commit (pushed or not) or an
  // edit after the merge is new work — it must stay visible, get pushed,
  // and block archiving until it's shipped too.
  // A tree git couldn't read may hold anything: never done on a guess.
  if (r.gitError) return { done: false };
  if (r.pr?.state === 'MERGED') {
    const nothingSince = r.dirtyFiles === 0 && !r.ahead && checkedOutMerged(r);
    return nothingSince ? { done: true, reason: 'merged' } : { done: false };
  }
  // Untouched only when every fact was read: a gh that failed (no network right after a
  // wake) is not "no PR", and a git that failed is not "0 commits" — reading them so once
  // archived a group whose other PR was still open.
  if (!r.pr && !r.ghError && r.dirtyFiles === 0 && r.commitsVsBase === 0) return { done: true, reason: 'untouched' };
  return { done: false };
}

/** Why "merge" isn't available for this repo right now ([] = go). */
export function mergeBlockers(r: RepoFacts): string[] {
  if (repoDone(r).done) return [];
  const out: string[] = [];
  if (r.gitError) out.push(r.gitError);
  if (r.ghError) out.push(r.ghError);
  if (r.dirtyFiles > 0) out.push(`${r.dirtyFiles} uncommitted file${r.dirtyFiles === 1 ? '' : 's'} — commit or stash first`);
  if (!r.hasUpstream) out.push('branch not pushed yet');
  if (r.ahead && r.ahead > 0) out.push(`${r.ahead} unpushed commit${r.ahead === 1 ? '' : 's'}`);
  if (r.behind && r.behind > 0) out.push(`origin has ${r.behind} commit${r.behind === 1 ? '' : 's'} you don't have locally — pull first`);
  if (!r.pr) {
    if (!r.ghError) out.push('no pull request');
    return out;
  }
  if (r.pr.state === 'CLOSED') out.push('pull request is closed');
  if (r.pr.state === 'MERGED') {
    // Not done (repoDone), so there's work after the merge.
    out.push(`PR #${r.pr.number} is already merged — the new work needs a new PR`);
    return out;
  }
  if (r.pr.isDraft) out.push('pull request is a draft');
  // The PR must be exactly what you have locally: otherwise merging lands
  // commits you haven't seen (or leaves out ones you have).
  if (r.localSha && r.pr.headSha && r.pr.headSha !== r.localSha && !(r.ahead || r.behind)) {
    out.push("the PR's head isn't your local HEAD — push or pull first");
  }
  switch (r.pr.mergeStateStatus) {
    case 'DIRTY':
      out.push('merge conflicts with the base branch');
      break;
    case 'BEHIND':
      out.push('branch is behind the base branch');
      break;
    case 'BLOCKED':
      out.push('blocked by branch protection (reviews or required checks)');
      break;
    default:
      break;
  }
  if (r.pr.checks === 'fail') out.push('checks failing');
  else if (r.pr.checks === 'pending') out.push('checks still running');
  return out;
}

function oneLineErr(s: string): string {
  return (
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

/** Whether to ask GitHub about a repo's PR at all (the PR watch skips
 *  branches that were never pushed and have no PR it knows of). */
export type AskGh = (repo: { name: string; hasUpstream: boolean; commitsVsBase: number | null; host?: string }) => boolean;

async function inspectRepo(repo: { name: string; path: string }, run: CommandRunner, askGh?: AskGh): Promise<RepoShipState> {
  const git = (...args: string[]) => run('git', args, repo.path);
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  const localSha = (await git('rev-parse', 'HEAD')).stdout.trim();
  const status = await git('status', '--porcelain');
  const dirtyFiles = status.stdout.split('\n').filter((l) => l.trim()).length;
  const gitError =
    status.code === 0 ? undefined : `git couldn't read the working tree (${oneLineErr(status.stderr) || `exit ${status.code}`})`;

  // "Published" = origin/<branch> exists — NOT whatever @{u} points at.
  // `work tree` forks branches tracking origin/main, so @{u} is often the
  // base: measuring against it hides unpushed commits, and a plain push
  // fails ("upstream branch ... does not match the name of your current
  // branch").
  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasUpstream = (await git('rev-parse', '--verify', '--quiet', remoteRef)).code === 0;
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const tracksRemote = upstream.code === 0 && upstream.stdout.trim() === `origin/${branch}`;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (hasUpstream) {
    const counts = await git('rev-list', '--left-right', '--count', `${remoteRef}...HEAD`);
    const [b, a] = counts.stdout.trim().split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ahead = a;
      behind = b;
    }
  }

  let commitsVsBase: number | null = null;
  const baseRef = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD')).stdout.trim();
  // A git that failed (a timeout under load) tells nothing: no count, so never "untouched".
  if (status.code === 0 && baseRef && baseRef !== 'origin/HEAD') {
    // Only a count git gave: `Number('')` is 0, which read a failed git as "no commits".
    const count = await git('rev-list', '--count', `${baseRef}..HEAD`);
    if (count.code === 0 && /^\d+$/.test(count.stdout.trim())) commitsVsBase = Number(count.stdout.trim());
  }

  let pr: ShipPr | null = null;
  let ghError: string | undefined;
  // The repo's host (its origin's; GitHub when none claims it): a group's repos may be on different ones.
  const { host } = hostForRepo(repo.path);
  const skipGh = askGh
    ? !askGh({ name: repo.name, hasUpstream, commitsVsBase, ...(host.id === DEFAULT_HOST ? {} : { host: host.id }) })
    : false;
  const found = skipGh ? ({ kind: 'none' } as const) : await host.prForBranch(run, repo.path, branch);
  if (found.kind === 'pr') pr = found.pr;
  else if (found.kind === 'error') ghError = found.error;

  // Merged at another commit: is HEAD inside it? Exit 0 = yes, 1 = no; anything else (the
  // head was never fetched here) is unknown, and unknown is no — never done on a guess.
  let behindMergedHead = false;
  if (pr?.state === 'MERGED' && localSha && pr.headSha && localSha !== pr.headSha && /^[0-9a-f]{7,64}$/i.test(pr.headSha)) {
    behindMergedHead = (await git('merge-base', '--is-ancestor', 'HEAD', pr.headSha)).code === 0;
  }

  const facts: RepoFacts = {
    name: repo.name,
    path: repo.path,
    branch,
    localSha,
    ...(behindMergedHead ? { behindMergedHead } : {}),
    dirtyFiles,
    hasUpstream,
    tracksRemote,
    ahead,
    behind,
    pr,
    ghError,
    ...(host.id === DEFAULT_HOST ? {} : { host: host.id }),
    commitsVsBase,
    ...(gitError ? { gitError } : {}),
  };
  const { done, reason } = repoDone(facts);
  return { ...facts, done, doneReason: reason, mergeBlockers: mergeBlockers(facts) };
}

export async function shipPreflight(
  session: WorktreeSession,
  run: CommandRunner = defaultRunner,
  opts: { askGh?: AskGh } = {},
): Promise<ShipPreflight> {
  const repos = await Promise.all(shipRepos(session).map((r) => inspectRepo(r, run, opts.askGh)));
  return { repos };
}

async function push(r: RepoShipState, run: CommandRunner): Promise<ShipResult> {
  // Set tracking to origin/<branch> unless it already is; a plain push
  // with tracking on the base branch is refused by git.
  const args = r.tracksRemote ? ['push'] : ['push', '-u', 'origin', r.branch];
  const res = await run('git', args, r.path);
  return res.code === 0
    ? { repo: r.name, ok: true, message: r.hasUpstream ? 'pushed' : `published ${r.branch}` }
    : { repo: r.name, ok: false, message: oneLineErr(res.stderr) || 'git push failed' };
}

/**
 * push / create-pr across the session's repos. Done repos and repos with
 * no commits vs the base are skipped (reported ok), never failed.
 */
export async function runShipAction(
  session: WorktreeSession,
  action: 'push' | 'create-pr',
  opts: { draft?: boolean } = {},
  run: CommandRunner = defaultRunner,
): Promise<ShipResult[]> {
  const { repos } = await shipPreflight(session, run);
  const results: ShipResult[] = [];
  for (const r of repos) {
    if (r.done) {
      results.push({ repo: r.name, ok: true, message: r.doneReason === 'merged' ? 'already merged' : 'untouched — skipped' });
      continue;
    }
    if (r.commitsVsBase === 0 && !r.pr) {
      results.push({ repo: r.name, ok: true, message: 'no commits vs the base branch — skipped' });
      continue;
    }
    if (action === 'push') {
      if (r.hasUpstream && !r.ahead && r.tracksRemote) {
        results.push({ repo: r.name, ok: true, message: 'nothing to push' });
        continue;
      }
      results.push(await push(r, run));
      continue;
    }
    // create-pr (a MERGED PR that isn't done means new work → new PR)
    if (r.pr && r.pr.state === 'OPEN') {
      results.push({ repo: r.name, ok: true, message: `PR #${r.pr.number} already open`, url: r.pr.url });
      continue;
    }
    if (r.ghError) {
      results.push({ repo: r.name, ok: false, message: r.ghError });
      continue;
    }
    if (!r.hasUpstream || (r.ahead ?? 0) > 0 || !r.tracksRemote) {
      const pushed = await push(r, run);
      if (!pushed.ok) {
        results.push(pushed);
        continue;
      }
    }
    const made = await hostForRepo(r.path).host.createPr(run, r.path, r.branch, { draft: !!opts.draft });
    if (made.ok) results.push({ repo: r.name, ok: true, message: opts.draft ? 'draft PR opened' : 'PR opened', url: made.url });
    else results.push({ repo: r.name, ok: false, message: made.error });
  }
  return results;
}

export interface MergeOutcome {
  results: ShipResult[];
  /** Something was merged by this call. */
  mergedAny: boolean;
  /** After this call, every repo in the session is done. */
  allDone: boolean;
}

/**
 * Merge exactly the selected repos, at exactly the PR heads the user saw.
 *
 * Validation happens for ALL selected repos before ANY merge: an unknown
 * repo, a PR that moved (someone pushed after the user looked), or any
 * blocker refuses the whole call — no half-applied selection. Repos not
 * selected are never touched, so shipping a group in parts is a deliberate
 * choice, not an accident.
 */
export async function mergeSelected(
  session: WorktreeSession,
  selection: MergeSelection[],
  method: MergeMethod,
  run: CommandRunner = defaultRunner,
): Promise<MergeOutcome> {
  const { repos } = await shipPreflight(session, run);
  const byName = new Map(repos.map((r) => [r.name, r]));
  if (selection.length === 0) {
    return {
      results: [{ repo: '-', ok: false, message: 'no repositories selected' }],
      mergedAny: false,
      allDone: repos.every((r) => r.done),
    };
  }

  const problems: ShipResult[] = [];
  for (const sel of selection) {
    const r = byName.get(sel.name);
    if (!r) {
      problems.push({ repo: sel.name, ok: false, message: 'not a repository of this session' });
    } else if (r.done) {
      problems.push({ repo: r.name, ok: false, message: r.doneReason === 'merged' ? 'already merged' : 'nothing to merge' });
    } else if (!r.pr || r.pr.headSha !== sel.headSha) {
      problems.push({
        repo: r.name,
        ok: false,
        message: 'the pull request changed since you looked — review it again before merging',
      });
    } else if (r.mergeBlockers.length > 0) {
      problems.push({ repo: r.name, ok: false, message: `not merged: ${r.mergeBlockers.join('; ')}` });
    }
  }
  if (problems.length > 0) {
    const failed = new Set(problems.map((p) => p.repo));
    const held = selection
      .filter((s) => !failed.has(s.name))
      .map((s) => ({ repo: s.name, ok: false, message: 'not merged: another selected repo is blocked' }));
    return { results: [...problems, ...held], mergedAny: false, allDone: repos.every((r) => r.done) };
  }

  const results: ShipResult[] = [];
  const mergedNow = new Set<string>();
  for (const sel of selection) {
    const r = byName.get(sel.name)!;
    const res = await hostForRepo(r.path).host.mergePr(run, r.path, r.pr!.number, method, sel.headSha);
    if (res.ok) {
      mergedNow.add(r.name);
      results.push({ repo: r.name, ok: true, merged: true, message: `PR #${r.pr!.number} merged (${method})`, url: r.pr!.url });
    } else {
      // Stop at the first failure rather than keep merging a partially
      // failing selection; what's merged is reported as merged.
      results.push({ repo: r.name, ok: false, message: res.error });
      break;
    }
  }
  const attempted = new Set(results.map((x) => x.repo));
  for (const sel of selection) {
    if (!attempted.has(sel.name)) {
      results.push({ repo: sel.name, ok: false, message: 'not merged: stopped after an earlier failure' });
    }
  }
  const allDone = repos.every((r) => r.done || mergedNow.has(r.name));
  return { results, mergedAny: mergedNow.size > 0, allDone };
}
