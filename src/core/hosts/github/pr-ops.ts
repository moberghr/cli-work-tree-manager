import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChecksState, FailingCheck, MergeMethod, ShipPr } from '../../api-types.js';
import { RUN_TIMED_OUT, type CommandRunner } from '../../platform/command-runner.js';
import type { HostResult, OpenPr, PrForStart, PrLookup, SubmitReviewResult } from '../types.js';
import { refusedClearly } from '../submit-doubt.js';

/**
 * GitHub's PR operations through `gh` (argv only): a branch's PR (Ship and
 * the PR watch), a PR by number (Start from a PR), its state (Blocked by),
 * open, merge with the head guard, and the merged PR of a gone branch
 * (branch tidy). Moved from ship.ts, pr-start.ts, branch-tidy.ts and
 * web-server.ts; the parsing is unchanged.
 */

export interface CheckRollupItem {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  /** Check runs carry name + detailsUrl; commit statuses context + targetUrl. */
  name?: string | null;
  context?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** The failed checks in a rollup, named, with their links. */
export function failingFromRollup(rollup: CheckRollupItem[] | null | undefined): FailingCheck[] {
  return (rollup ?? [])
    .filter((c) => FAILED.includes((c.conclusion ?? c.state ?? '').toUpperCase()))
    .map((c) => {
      const url = c.detailsUrl ?? c.targetUrl ?? undefined;
      return { name: c.name ?? c.context ?? 'check', ...(url ? { url } : {}) };
    });
}

/** Collapse gh's statusCheckRollup (check runs + commit statuses). */
export function checksFromRollup(rollup: CheckRollupItem[] | null | undefined): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const v = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (FAILED.includes(v)) {
      return 'fail';
    }
    const status = (c.status ?? '').toUpperCase();
    if (!v || v === 'PENDING' || v === 'EXPECTED' || (status && status !== 'COMPLETED')) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/** First line of a CLI's error output. */
export const oneLineErr = (s: string) => s.trim().split('\n')[0] ?? '';

/**
 * The line of gh's error output that says why: the one about GitHub's API limit wherever it is (gh may warn
 * first, and the limit is what the watch and the blockers' sweep rest on), else the first.
 */
export const reasonLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /rate limit/i.test(l)) ?? oneLineErr(s);

/** `gh pr view <branch>`: the branch's PR as work's ShipPr, none, or why gh couldn't say. */
export async function githubPrForBranch(run: CommandRunner, cwd: string, branch: string): Promise<PrLookup> {
  const view = await run(
    'gh',
    [
      'pr',
      'view',
      branch,
      '--json',
      'number,url,state,isDraft,mergeStateStatus,headRefOid,mergedAt,updatedAt,statusCheckRollup,reviewDecision,author,baseRefName',
    ],
    cwd,
  );
  if (view.code === 0) {
    try {
      const j = JSON.parse(view.stdout) as {
        number: number;
        url: string;
        state: ShipPr['state'];
        isDraft: boolean;
        mergeStateStatus?: string;
        headRefOid: string;
        mergedAt?: string | null;
        updatedAt?: string;
        statusCheckRollup?: CheckRollupItem[];
        reviewDecision?: string | null;
        author?: { login?: string } | null;
        baseRefName?: string;
      };
      const pr: ShipPr = {
        number: j.number,
        url: j.url,
        state: j.state,
        isDraft: j.isDraft,
        mergeStateStatus: j.mergeStateStatus ?? 'UNKNOWN',
        checks: checksFromRollup(j.statusCheckRollup),
        headSha: j.headRefOid,
        ...(j.mergedAt ? { mergedAt: j.mergedAt } : {}),
        ...(j.updatedAt ? { updatedAt: j.updatedAt } : {}),
        ...(typeof j.reviewDecision === 'string' ? { reviewDecision: j.reviewDecision } : {}),
        // gh pr view names an app `app/dependabot`; the search API, `dependabot`.
        ...(j.author?.login ? { author: j.author.login.replace(/^app\//, '') } : {}),
        ...(j.baseRefName ? { baseBranch: j.baseRefName } : {}),
        ...(checksFromRollup(j.statusCheckRollup) === 'fail' ? { failing: failingFromRollup(j.statusCheckRollup) } : {}),
      };
      return { kind: 'pr', pr };
    } catch {
      return { kind: 'error', error: 'could not read `gh pr view` output' };
    }
  }
  if (view.code === 127) return { kind: 'error', error: 'GitHub CLI (gh) not found — install it to open and merge PRs' };
  if (/no pull requests found/i.test(view.stderr)) return { kind: 'none' };
  return { kind: 'error', error: reasonLine(view.stderr) || 'gh pr view failed' };
}

/** `gh pr create --fill`: the new PR's link when gh printed one. */
export async function githubCreatePr(
  run: CommandRunner,
  cwd: string,
  branch: string,
  opts: { draft: boolean },
): Promise<HostResult<{ url?: string }>> {
  const args = ['pr', 'create', '--fill', '--head', branch];
  if (opts.draft) args.push('--draft');
  const res = await run('gh', args, cwd);
  if (res.code !== 0) return { ok: false, error: oneLineErr(res.stderr) || 'gh pr create failed' };
  const url = res.stdout
    .trim()
    .split(/\s+/)
    .find((t) => t.startsWith('http'));
  return { ok: true, ...(url ? { url } : {}) };
}

/** `gh pr merge --match-head-commit`: GitHub refuses when the PR moved past the commit you were shown. */
export async function githubMergePr(
  run: CommandRunner,
  cwd: string,
  number: number,
  method: MergeMethod,
  headSha: string,
): Promise<HostResult> {
  const res = await run('gh', ['pr', 'merge', String(number), `--${method}`, '--match-head-commit', headSha], cwd);
  return res.code === 0 ? { ok: true } : { ok: false, error: oneLineErr(res.stderr) || 'gh pr merge failed' };
}

/** The fields of `gh pr view --json …` this reads; all optional — it is someone else's output. */
interface GhPrView {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  state?: string;
  isCrossRepository?: boolean;
  author?: { login?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
}

/** `gh pr view <n> --repo owner/name`: a PR to start a session on. */
export async function githubPrByNumber(
  run: CommandRunner,
  cwd: string,
  repoId: string,
  number: number,
): Promise<HostResult<{ pr: PrForStart }>> {
  const view = await run(
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--repo',
      repoId,
      '--json',
      'number,title,url,headRefName,headRefOid,baseRefName,state,isCrossRepository,author,headRepositoryOwner',
    ],
    cwd,
  );
  if (view.code === 127) return { ok: false, error: 'GitHub CLI (gh) not found: install it to start from a PR.' };
  if (view.code !== 0) return { ok: false, error: `PR #${number} in ${repoId}: ${oneLineErr(view.stderr) || 'gh pr view failed'}` };
  let pr: GhPrView;
  try {
    pr = JSON.parse(view.stdout) as GhPrView;
  } catch {
    return { ok: false, error: "Couldn't read what gh said about the PR." };
  }
  return {
    ok: true,
    pr: {
      number: pr.number ?? number,
      title: pr.title ?? '',
      url: pr.url ?? '',
      branch: pr.headRefName ?? '',
      ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      base: pr.baseRefName ?? '',
      author: (pr.author?.login ?? '').replace(/^app\//, ''),
      state: pr.state ?? 'OPEN',
      ...(pr.isCrossRepository ? { fork: { owner: pr.headRepositoryOwner?.login ?? 'a fork' } } : {}),
    },
  };
}

/** `gh pr view <url> --json state`: what a "blocked by" PR is now. */
export async function githubPrState(
  run: CommandRunner,
  url: string,
  cwd: string,
): Promise<HostResult<{ state: 'OPEN' | 'MERGED' | 'CLOSED' }>> {
  const r = await run('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], cwd);
  if (r.code !== 0) return { ok: false, error: reasonLine(r.stderr) || 'gh pr view failed' };
  const st = r.stdout.trim();
  return st === 'OPEN' || st === 'MERGED' || st === 'CLOSED' ? { ok: true, state: st } : { ok: false, error: `gh said ${st || 'nothing'}` };
}

/**
 * A gone branch's MERGED PR whose head is exactly `tip` (a squash merge git
 * can't see): its number; null when there's none; undefined when gh couldn't say.
 */
export async function githubMergedPr(run: CommandRunner, cwd: string, branch: string, tip: string): Promise<number | null | undefined> {
  const pr = await run('gh', ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,headRefOid', '--limit', '5'], cwd);
  if (pr.code !== 0) return undefined;
  try {
    const list = JSON.parse(pr.stdout) as Array<{ number: number; headRefOid: string }>;
    return list.find((p) => p.headRefOid === tip)?.number ?? null;
  } catch {
    return undefined; // not JSON: not certain, not offered
  }
}

/** How many open PRs one listing asks for; a list that long may have stopped short (`more`). */
export const OPEN_PR_LIMIT = 100;

/** `gh pr list --state open`: every open PR of the repo, for the review queue. */
export async function githubOpenPrs(run: CommandRunner, cwd: string): Promise<HostResult<{ prs: OpenPr[]; more?: boolean }>> {
  const r = await run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(OPEN_PR_LIMIT),
      '--json',
      'number,title,url,headRefName,headRefOid,baseRefName,author,isDraft,additions,deletions,reviewRequests',
    ],
    cwd,
  );
  if (r.code === 127) return { ok: false, error: 'GitHub CLI (gh) not found' };
  if (r.code !== 0) return { ok: false, error: oneLineErr(r.stderr) || 'gh pr list failed' };
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "couldn't read what gh said" };
  }
  if (!Array.isArray(list)) return { ok: false, error: "couldn't read what gh said" };
  const prs = list.flatMap((x): OpenPr[] => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.number !== 'number' || typeof o.headRefOid !== 'string') return [];
    const login = (v: unknown) =>
      v && typeof v === 'object' && typeof (v as { login?: unknown }).login === 'string' ? (v as { login: string }).login : '';
    return [
      {
        number: o.number,
        title: typeof o.title === 'string' ? o.title : '',
        url: typeof o.url === 'string' ? o.url : '',
        branch: typeof o.headRefName === 'string' ? o.headRefName : '',
        headSha: o.headRefOid,
        base: typeof o.baseRefName === 'string' ? o.baseRefName : '',
        author: login(o.author).replace(/^app\//, ''),
        isDraft: o.isDraft === true,
        additions: typeof o.additions === 'number' ? o.additions : 0,
        deletions: typeof o.deletions === 'number' ? o.deletions : 0,
        requested: Array.isArray(o.reviewRequests) ? o.reviewRequests.map(login).filter(Boolean) : [],
      },
    ];
  });
  return { ok: true, prs, ...(list.length >= OPEN_PR_LIMIT ? { more: true } : {}) };
}

const GITHUB_EVENT = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' } as const;

/** One review with its line comments (`gh api …/pulls/<n>/reviews --input`; gh fills owner and repo from the cwd). */
export async function githubSubmitReview(
  run: CommandRunner,
  cwd: string,
  number: number,
  review: {
    commitId: string;
    event: keyof typeof GITHUB_EVENT;
    body: string;
    comments: Array<{ path: string; line: number; body: string }>;
  },
): Promise<SubmitReviewResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-gh-'));
  try {
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        commit_id: review.commitId,
        event: GITHUB_EVENT[review.event],
        body: review.body,
        comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
      }),
    );
    const r = await run('gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', file], cwd);
    // One call makes the whole review, or none of it — unless it failed without a clear refusal (timed out, a 5xx, a
    // dropped connection): then GitHub may have made it.
    if (r.code !== 0) {
      const error = oneLineErr(r.stderr) || (r.code === RUN_TIMED_OUT ? 'gh timed out' : 'gh could not submit the review');
      return refusedClearly(r.code, r.stderr, GH_REFUSAL)
        ? { ok: false, error }
        : { ok: false, error, inDoubt: { comments: review.comments.map((_, i) => i), summary: !!review.body.trim() } };
    }
    try {
      const url = (JSON.parse(r.stdout) as { html_url?: unknown }).html_url;
      return { ok: true, ...(typeof url === 'string' ? { url } : {}) };
    } catch {
      return { ok: true };
    }
  } finally {
    // Tidying the temp folder never turns a call that went through into a failure (a retry would post it again).
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp file; the OS clears its temp folder */
    }
  }
}

/** gh's own words for a request it never made, or GitHub refused: signed out, no such repo. */
const GH_REFUSAL = /gh auth login|not logged in|authentication required|Could not resolve to a Repository/i;
