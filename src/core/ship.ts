import path from 'node:path';
import crossSpawn from 'cross-spawn';
import type { WorktreeSession } from './history.js';

/**
 * Ship a session's work: push, open a PR, merge it. Per repo, so a group
 * ships each sub-repo that has something to ship.
 *
 * Every git/gh call goes through a `CommandRunner` with an argv array — no
 * shell (§1.1) — injectable so the decision logic is unit-testable without
 * GitHub. Merge passes `--match-head-commit <sha>` so GitHub refuses it if
 * the branch moved after the user looked (the optimistic-concurrency guard
 * Emdash uses via the API).
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

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';

export interface ShipPr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  mergeStateStatus: string;
  checks: ChecksState;
  headSha: string;
}

export interface RepoShipState {
  name: string;
  path: string;
  branch: string;
  dirtyFiles: number;
  hasUpstream: boolean;
  ahead: number | null;
  behind: number | null;
  pr: ShipPr | null;
  mergeBlockers: string[];
  ghError?: string;
  /** Commits on this branch that the remote's default branch doesn't have
   *  (null when that can't be determined). 0 = nothing to ship from here —
   *  typically an untouched sub-repo of a group. */
  commitsVsBase?: number | null;
}

export interface ShipPreflight {
  repos: RepoShipState[];
}

export type ShipAction = 'push' | 'create-pr' | 'merge';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ShipResult {
  repo: string;
  ok: boolean;
  message: string;
  url?: string;
}

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

/** Why "merge" isn't available for this repo right now ([] = go). */
export function mergeBlockers(r: Omit<RepoShipState, 'mergeBlockers'>): string[] {
  const out: string[] = [];
  if (r.ghError) out.push(r.ghError);
  if (r.dirtyFiles > 0) out.push(`${r.dirtyFiles} uncommitted file${r.dirtyFiles === 1 ? '' : 's'} — commit or stash first`);
  if (r.ahead && r.ahead > 0) out.push(`${r.ahead} unpushed commit${r.ahead === 1 ? '' : 's'}`);
  if (!r.pr) {
    if (!r.ghError) out.push('no pull request');
    return out;
  }
  if (r.pr.state !== 'OPEN') out.push(`pull request is ${r.pr.state.toLowerCase()}`);
  if (r.pr.isDraft) out.push('pull request is a draft');
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

async function inspectRepo(
  repo: { name: string; path: string },
  run: CommandRunner,
): Promise<RepoShipState> {
  const git = (...args: string[]) => run('git', args, repo.path);
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  const status = await git('status', '--porcelain');
  const dirtyFiles = status.stdout.split('\n').filter((l) => l.trim()).length;
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const upstreamRef = upstream.code === 0 ? upstream.stdout.trim() : '';
  // Only an upstream with the branch's own name counts. `work tree` forks new
  // branches from origin/main with tracking set to it, so @{u} is often the
  // BASE: a plain `git push` then fails ("upstream branch ... does not match
  // the name of your current branch") and ahead/behind would be measured
  // against main. Treat that as unpublished and push with -u instead.
  const hasUpstream = upstreamRef.length > 0 && upstreamRef.endsWith('/' + branch);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (hasUpstream) {
    const counts = await git('rev-list', '--left-right', '--count', '@{u}...HEAD');
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

  const base = { name: repo.name, path: repo.path, branch, dirtyFiles, hasUpstream, ahead, behind, pr, ghError, commitsVsBase };
  return { ...base, mergeBlockers: mergeBlockers(base) };
}

function oneLineErr(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

export async function shipPreflight(
  session: WorktreeSession,
  run: CommandRunner = defaultRunner,
): Promise<ShipPreflight> {
  const repos = await Promise.all(shipRepos(session).map((r) => inspectRepo(r, run)));
  return { repos };
}

async function push(r: RepoShipState, run: CommandRunner): Promise<ShipResult> {
  const args = r.hasUpstream ? ['push'] : ['push', '-u', 'origin', r.branch];
  const res = await run('git', args, r.path);
  return res.code === 0
    ? { repo: r.name, ok: true, message: r.hasUpstream ? 'pushed' : `published ${r.branch}` }
    : { repo: r.name, ok: false, message: oneLineErr(res.stderr) || 'git push failed' };
}

/**
 * Run one ship action across the session's repos. Repos where the action
 * doesn't apply (nothing to push, PR already open) are reported as skipped,
 * not failed. `merge` re-checks the blockers first and refuses rather than
 * trusting the client.
 */
export async function runShipAction(
  session: WorktreeSession,
  action: ShipAction,
  opts: { method?: MergeMethod; draft?: boolean } = {},
  run: CommandRunner = defaultRunner,
): Promise<ShipResult[]> {
  const { repos } = await shipPreflight(session, run);
  const results: ShipResult[] = [];
  if (action === 'merge') return mergeAll(repos, opts.method ?? 'squash', run);
  for (const r of repos) {
    if (r.commitsVsBase === 0 && !r.pr && r.dirtyFiles === 0) {
      results.push({ repo: r.name, ok: true, message: 'no commits vs the base branch — skipped' });
      continue;
    }
    if (action === 'push') {
      if (r.hasUpstream && !r.ahead) {
        results.push({ repo: r.name, ok: true, message: 'nothing to push' });
        continue;
      }
      results.push(await push(r, run));
      continue;
    }
    if (action === 'create-pr') {
      if (r.pr && r.pr.state === 'OPEN') {
        results.push({ repo: r.name, ok: true, message: `PR #${r.pr.number} already open`, url: r.pr.url });
        continue;
      }
      if (r.ghError) {
        results.push({ repo: r.name, ok: false, message: r.ghError });
        continue;
      }
      if (!r.hasUpstream || (r.ahead ?? 0) > 0) {
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
      continue;
    }
  }
  return results;
}

/**
 * Merge every repo that has something shipped — all or nothing. A group's
 * sub-repos are one feature; merging the ready ones while another is
 * blocked would leave main half-shipped, so any blocker stops them all.
 */
async function mergeAll(
  repos: RepoShipState[],
  method: MergeMethod,
  run: CommandRunner,
): Promise<ShipResult[]> {
  // Untouched sub-repos (no commits vs the base, no PR, clean) aren't part
  // of the ship. When that can't be determined, the repo is treated as
  // shipping — and its "no pull request" blocker stops the merge — rather
  // than silently skipped.
  const idle = (r: RepoShipState) => !r.pr && r.dirtyFiles === 0 && r.commitsVsBase === 0;
  const toMerge = repos.filter((r) => !idle(r));
  const skipped: ShipResult[] = repos
    .filter(idle)
    .map((r) => ({ repo: r.name, ok: true, message: 'nothing to merge' }));
  if (toMerge.length === 0) {
    return skipped.length ? skipped : [{ repo: '-', ok: false, message: 'nothing to merge' }];
  }
  const blocked = toMerge.filter((r) => r.mergeBlockers.length > 0);
  if (blocked.length > 0) {
    return [
      ...toMerge.map((r) => ({
        repo: r.name,
        ok: false,
        message: r.mergeBlockers.length
          ? `not merged: ${r.mergeBlockers.join('; ')}`
          : 'not merged: another repo in this group is blocked',
      })),
      ...skipped,
    ];
  }
  const results: ShipResult[] = [];
  for (const r of toMerge) {
    const res = await run(
      'gh',
      ['pr', 'merge', String(r.pr!.number), `--${method}`, '--match-head-commit', r.pr!.headSha],
      r.path,
    );
    results.push(
      res.code === 0
        ? { repo: r.name, ok: true, message: `PR #${r.pr!.number} merged (${method})`, url: r.pr!.url }
        : { repo: r.name, ok: false, message: oneLineErr(res.stderr) || 'gh pr merge failed' },
    );
  }
  return [...results, ...skipped];
}
