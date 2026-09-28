import path from 'node:path';
import crossSpawn from 'cross-spawn';
import type { WorktreeSession } from './history.js';
import type {
  ChecksState,
  MergeMethod,
  MergeSelection,
  RepoShipState,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipResult,
} from './api-types.js';

export type {
  ChecksState,
  MergeMethod,
  MergeSelection,
  RepoShipState,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipResult,
} from './api-types.js';

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

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

/**
 * Real runner: cross-spawn, not execFile — on Windows execFile only finds
 * .exe files, so a `gh` installed as a .cmd shim (scoop, wrappers) would
 * look "not installed"; cross-spawn resolves shims like `work tree` does,
 * with cmd-escaped args. Exit code 127 = the binary itself is missing.
 */
export const defaultRunner: CommandRunner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = crossSpawn(cmd, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: 124, stdout, stderr: stderr || `${cmd} timed out` });
    }, 60_000);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      done({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: err.message });
    });
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });

/** The repos a session ships: each worktree path, named by its folder. */
export function shipRepos(session: WorktreeSession): Array<{ name: string; path: string }> {
  return session.paths.map((p) => ({
    name: session.isGroup ? path.basename(p) : session.target,
    path: p,
  }));
}

interface CheckRollupItem {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Collapse gh's statusCheckRollup (check runs + commit statuses). */
export function checksFromRollup(rollup: CheckRollupItem[] | null | undefined): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const v = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) {
      return 'fail';
    }
    const status = (c.status ?? '').toUpperCase();
    if (!v || v === 'PENDING' || v === 'EXPECTED' || (status && status !== 'COMPLETED')) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

type RepoFacts = Omit<RepoShipState, 'mergeBlockers' | 'done' | 'doneReason'>;

/** Done = nothing left to ship from this repo. */
export function repoDone(r: RepoFacts): { done: boolean; reason?: 'merged' | 'untouched' } {
  // Merged AND nothing since: a follow-up commit (pushed or not) or an
  // edit after the merge is new work — it must stay visible, get pushed,
  // and block archiving until it's shipped too.
  if (r.pr?.state === 'MERGED') {
    const nothingSince = r.dirtyFiles === 0 && !r.ahead && (!r.localSha || r.localSha === r.pr.headSha);
    return nothingSince ? { done: true, reason: 'merged' } : { done: false };
  }
  if (!r.pr && r.dirtyFiles === 0 && r.commitsVsBase === 0) return { done: true, reason: 'untouched' };
  return { done: false };
}

/** Why "merge" isn't available for this repo right now ([] = go). */
export function mergeBlockers(r: RepoFacts): string[] {
  if (repoDone(r).done) return [];
  const out: string[] = [];
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
    case 'DIRTY': out.push('merge conflicts with the base branch'); break;
    case 'BEHIND': out.push('branch is behind the base branch'); break;
    case 'BLOCKED': out.push('blocked by branch protection (reviews or required checks)'); break;
    default: break;
  }
  if (r.pr.checks === 'fail') out.push('checks failing');
  else if (r.pr.checks === 'pending') out.push('checks still running');
  return out;
}

function oneLineErr(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

async function inspectRepo(
  repo: { name: string; path: string },
  run: CommandRunner,
): Promise<RepoShipState> {
  const git = (...args: string[]) => run('git', args, repo.path);
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  const localSha = (await git('rev-parse', 'HEAD')).stdout.trim();
  const status = await git('status', '--porcelain');
  const dirtyFiles = status.stdout.split('\n').filter((l) => l.trim()).length;

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
  if (baseRef && baseRef !== 'origin/HEAD') {
    const n = Number((await git('rev-list', '--count', `${baseRef}..HEAD`)).stdout.trim());
    if (Number.isFinite(n)) commitsVsBase = n;
  }

  let pr: ShipPr | null = null;
  let ghError: string | undefined;
  const view = await run(
    'gh',
    ['pr', 'view', branch, '--json', 'number,url,state,isDraft,mergeStateStatus,headRefOid,statusCheckRollup'],
    repo.path,
  );
  if (view.code === 0) {
    try {
      const j = JSON.parse(view.stdout) as {
        number: number; url: string; state: ShipPr['state']; isDraft: boolean;
        mergeStateStatus?: string; headRefOid: string; statusCheckRollup?: CheckRollupItem[];
      };
      pr = {
        number: j.number,
        url: j.url,
        state: j.state,
        isDraft: j.isDraft,
        mergeStateStatus: j.mergeStateStatus ?? 'UNKNOWN',
        checks: checksFromRollup(j.statusCheckRollup),
        headSha: j.headRefOid,
      };
    } catch {
      ghError = 'could not read `gh pr view` output';
    }
  } else if (view.code === 127) {
    ghError = 'GitHub CLI (gh) not found — install it to open and merge PRs';
  } else if (!/no pull requests found/i.test(view.stderr)) {
    ghError = oneLineErr(view.stderr) || 'gh pr view failed';
  }

  const facts: RepoFacts = {
    name: repo.name, path: repo.path, branch, localSha, dirtyFiles,
    hasUpstream, tracksRemote, ahead, behind, pr, ghError, commitsVsBase,
  };
  const { done, reason } = repoDone(facts);
  return { ...facts, done, doneReason: reason, mergeBlockers: mergeBlockers(facts) };
}

export async function shipPreflight(
  session: WorktreeSession,
  run: CommandRunner = defaultRunner,
): Promise<ShipPreflight> {
  const repos = await Promise.all(shipRepos(session).map((r) => inspectRepo(r, run)));
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
    const args = ['pr', 'create', '--fill', '--head', r.branch];
    if (opts.draft) args.push('--draft');
    const res = await run('gh', args, r.path);
    if (res.code === 0) {
      const url = res.stdout.trim().split(/\s+/).find((t) => t.startsWith('http'));
      results.push({ repo: r.name, ok: true, message: opts.draft ? 'draft PR opened' : 'PR opened', url });
    } else {
      results.push({ repo: r.name, ok: false, message: oneLineErr(res.stderr) || 'gh pr create failed' });
    }
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
    return { results: [{ repo: '-', ok: false, message: 'no repositories selected' }], mergedAny: false, allDone: repos.every((r) => r.done) };
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
    const res = await run(
      'gh',
      ['pr', 'merge', String(r.pr!.number), `--${method}`, '--match-head-commit', sel.headSha],
      r.path,
    );
    if (res.code === 0) {
      mergedNow.add(r.name);
      results.push({ repo: r.name, ok: true, merged: true, message: `PR #${r.pr!.number} merged (${method})`, url: r.pr!.url });
    } else {
      // Stop at the first failure rather than keep merging a partially
      // failing selection; what's merged is reported as merged.
      results.push({ repo: r.name, ok: false, message: oneLineErr(res.stderr) || 'gh pr merge failed' });
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
