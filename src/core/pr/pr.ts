import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { originUrl, ownerRepo } from '../worktree/repo-scan.js';

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  url: string;
  isDraft: boolean;
  checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE';
  /** Current user's latest review state on this PR. */
  myReview: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'NONE';
  /** Whether the current user is the PR author. */
  isMine: boolean;
  /** It can't merge as it is: a conflict with its base (checks say nothing about that). */
  conflicting: boolean;
  /** Your review was asked for, by name (a team's request isn't known here). */
  reviewRequested: boolean;
  /** Repo alias this PR belongs to (for distinguishing group PRs). */
  repoAlias: string;
}

/**
 * Map from branch name to array of PRs (one per repo that has a PR for that branch).
 * Single-repo sessions will have at most 1 entry; groups can have multiple.
 */
export type BranchPrMap = Map<string, PullRequestInfo[]>;

function execAsync(cmd: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // `windowsHide: true` prevents a console window from flashing on
    // Windows whenever the PRs pane refreshes. Without it, opening
    // the PRs pane in `work web` triggers a visible terminal popup
    // for every configured repo's `gh pr list` invocation.
    execFile(cmd, args, { cwd, encoding: 'utf-8', timeout, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

/** The fields of `gh pr list --json …` this reads; all optional — it is someone else's output. */
interface GhPr {
  number?: number;
  title?: string;
  headRefName?: string;
  url?: string;
  isDraft?: boolean;
  mergeable?: string;
  reviewDecision?: string;
  author?: { login?: string } | null;
  statusCheckRollup?: Array<{ conclusion?: string | null; status?: string | null }> | null;
  reviews?: Array<{ author?: { login?: string } | null; state?: string }> | null;
  reviewRequests?: Array<{ login?: string } | null> | null;
}

/** `gh pr list --json …` output as work's PR rows: checks, review, yours or not, conflicts, review asked of you. Pure. */
export function parsePrJson(stdout: string, repoAlias: string, currentUser: string): PullRequestInfo[] {
  const parsed = JSON.parse(stdout) as unknown;
  const prs: GhPr[] = Array.isArray(parsed) ? (parsed as GhPr[]) : [];
  return prs.map((pr) => toPrInfo(pr, repoAlias, currentUser));
}

/** One PR as work's row. */
function toPrInfo(pr: GhPr, repoAlias: string, currentUser: string): PullRequestInfo {
  {
    let checksStatus: PullRequestInfo['checksStatus'] = 'NONE';
    const checks = pr.statusCheckRollup ?? [];
    if (checks.length > 0) {
      const hasFailure = checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.conclusion === 'CANCELLED');
      const hasPending = checks.some((c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING');
      if (hasFailure) checksStatus = 'FAILURE';
      else if (hasPending) checksStatus = 'PENDING';
      else checksStatus = 'SUCCESS';
    }

    let reviewDecision: PullRequestInfo['reviewDecision'] = 'NONE';
    if (pr.reviewDecision === 'APPROVED') reviewDecision = 'APPROVED';
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') reviewDecision = 'CHANGES_REQUESTED';
    else if (pr.reviewDecision === 'REVIEW_REQUIRED') reviewDecision = 'REVIEW_REQUIRED';

    // Check current user's latest review state
    let myReview: PullRequestInfo['myReview'] = 'NONE';
    if (currentUser) {
      const reviews = pr.reviews ?? [];
      for (let i = reviews.length - 1; i >= 0; i--) {
        if (reviews[i].author?.login?.toLowerCase() === currentUser.toLowerCase()) {
          const state = reviews[i].state;
          if (state === 'APPROVED') myReview = 'APPROVED';
          else if (state === 'CHANGES_REQUESTED') myReview = 'CHANGES_REQUESTED';
          else if (state === 'COMMENTED') myReview = 'COMMENTED';
          break;
        }
      }
    }

    return {
      number: pr.number ?? 0,
      title: pr.title ?? '',
      branch: pr.headRefName ?? '',
      url: pr.url ?? '',
      isDraft: pr.isDraft ?? false,
      checksStatus,
      reviewDecision,
      myReview,
      isMine: currentUser ? pr.author?.login?.toLowerCase() === currentUser.toLowerCase() : false,
      conflicting: pr.mergeable === 'CONFLICTING',
      reviewRequested: !!currentUser && (pr.reviewRequests ?? []).some((r) => r?.login?.toLowerCase() === currentUser.toLowerCase()),
      repoAlias,
    };
  }
}

/**
 * Your open PRs and the ones asking for your review, across every GitHub
 * repo, in ONE GraphQL call (about one API point). The list used to be a
 * `gh pr list` per enrolled repo every two minutes: 27 calls for 27 repos.
 * Start shows only these two kinds anyway.
 */
export const PR_SEARCH_QUERY = `query($mine: String!, $asked: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 100) { issueCount nodes { ...pr } }
  asked: search(query: $asked, type: ISSUE, first: 100) { issueCount nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft headRefName mergeable reviewDecision
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  latestReviews(first: 20) { nodes { author { login } state } }
}`;

/** The search's two queries: open PRs by you, and open PRs asking you by name. */
export const PR_SEARCH_VARS = {
  mine: 'is:pr is:open archived:false author:@me',
  asked: 'is:pr is:open archived:false review-requested:@me',
};

interface SearchNode extends Omit<GhPr, 'statusCheckRollup' | 'reviews' | 'reviewRequests'> {
  repository?: { nameWithOwner?: string } | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null> | null } | null;
  reviewRequests?: { nodes?: Array<{ requestedReviewer?: { login?: string } | null } | null> | null } | null;
  latestReviews?: { nodes?: Array<{ author?: { login?: string } | null; state?: string } | null> | null } | null;
}

/** A check rollup's one word, in the shape `gh pr list` gives (so one conversion reads both). */
function rollupAsChecks(state: string | undefined): GhPr['statusCheckRollup'] {
  if (state === 'FAILURE' || state === 'ERROR') return [{ conclusion: 'FAILURE', status: 'COMPLETED' }];
  if (state === 'PENDING' || state === 'EXPECTED') return [{ conclusion: null, status: 'PENDING' }];
  if (state === 'SUCCESS') return [{ conclusion: 'SUCCESS', status: 'COMPLETED' }];
  return [];
}

/**
 * The search's answer as work's PR rows, each under the alias (or aliases)
 * enrolled for its repository; PRs of repos you haven't enrolled are left
 * out, as before. `incomplete` when a search found more than it returned. Pure.
 */
export function parsePrSearch(
  stdout: string,
  aliasesOf: (nameWithOwner: string) => string[],
): { prs: PullRequestInfo[]; incomplete: boolean } {
  const data = (JSON.parse(stdout) as { data?: Record<string, unknown> } | null)?.data ?? {};
  const user = ((data.viewer as { login?: string } | undefined)?.login ?? '').trim();
  const seen = new Set<string>();
  const prs: PullRequestInfo[] = [];
  let incomplete = false;
  for (const key of ['mine', 'asked']) {
    const result = data[key] as { issueCount?: number; nodes?: Array<SearchNode | null> } | undefined;
    const nodes = (result?.nodes ?? []).filter((n): n is SearchNode => !!n && typeof n.number === 'number');
    if ((result?.issueCount ?? 0) > nodes.length) incomplete = true;
    for (const n of nodes) {
      const pr: GhPr = {
        ...n,
        statusCheckRollup: rollupAsChecks(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
        reviews: (n.latestReviews?.nodes ?? []).filter((r) => !!r),
        reviewRequests: (n.reviewRequests?.nodes ?? []).map((r) => r?.requestedReviewer ?? null),
      };
      for (const alias of aliasesOf(n.repository?.nameWithOwner ?? '')) {
        const id = `${alias}#${n.number}`;
        if (seen.has(id)) continue;
        seen.add(id);
        prs.push(toPrInfo(pr, alias, user));
      }
    }
  }
  return { prs, incomplete };
}

/** parsePrSearch, or null for an answer that isn't JSON. */
function readSearch(stdout: string, aliasesOf: (nameWithOwner: string) => string[]): ReturnType<typeof parsePrSearch> | null {
  try {
    return parsePrSearch(stdout, aliasesOf);
  } catch {
    return null;
  }
}

/** `owner/name` (lowercase) of a repo's origin on github.com, from its `.git/config` text; null for another host or no origin. Pure. */
export function githubRepoOf(configText: string): string | null {
  const url = originUrl(configText);
  if (!url || !/(^|[@/.])github\.com[:/]/i.test(url)) return null;
  return ownerRepo(url)?.toLowerCase() ?? null;
}

/**
 * Fetch open PRs for a repo using `gh` CLI (async, non-blocking).
 */
const PR_LIST_LIMIT = 100;

/** Open PRs for a repo; null when gh couldn't say (missing, offline, not a GitHub repo). */
async function fetchPullRequests(repoPath: string, repoAlias: string, currentUser: string): Promise<PullRequestInfo[] | null> {
  try {
    const stdout = await execAsync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,headRefName,url,isDraft,statusCheckRollup,reviewDecision,reviews,reviewRequests,mergeable,author',
        '--limit',
        String(PR_LIST_LIMIT),
      ],
      repoPath,
      15000,
    );
    if (!stdout) return [];
    return parsePrJson(stdout, repoAlias, currentUser);
  } catch {
    return null;
  }
}

/**
 * Fetch PRs for all configured repos (async, non-blocking).
 * Runs all repo fetches in parallel.
 * Returns a map from branch name → array of PRs across repos.
 */
async function getCurrentUser(): Promise<string> {
  try {
    const stdout = await execAsync('gh', ['api', 'user', '--jq', '.login'], process.cwd(), 5000);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** What fetchAllPullRequests reaches outside (tests pass fakes). */
export interface PrListDeps {
  /** `gh api graphql` with the search: its stdout, or null when gh couldn't. */
  search: () => Promise<string | null>;
  /** One repo the old way (`gh pr list` there): not on github.com, or the search failed. */
  listRepo: (repoPath: string, alias: string) => Promise<PullRequestInfo[] | null>;
  /** A repo's `.git/config` text, or null. */
  gitConfig: (repoPath: string) => string | null;
}

function defaultPrListDeps(): PrListDeps {
  let user: Promise<string> | null = null;
  return {
    search: async () => {
      try {
        return await execAsync(
          'gh',
          ['api', 'graphql', '-f', `query=${PR_SEARCH_QUERY}`, '-f', `mine=${PR_SEARCH_VARS.mine}`, '-f', `asked=${PR_SEARCH_VARS.asked}`],
          process.cwd(),
          20000,
        );
      } catch {
        return null;
      }
    },
    listRepo: async (repoPath, alias) => fetchPullRequests(repoPath, alias, await (user ??= getCurrentUser())),
    gitConfig: (repoPath) => {
      try {
        return fs.readFileSync(path.join(repoPath, '.git', 'config'), 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * The PRs for the dashboard: one search for every repo on github.com (yours,
 * and those asking your review), and the old per-repo list only for repos
 * elsewhere (GitHub Enterprise, no origin) — or for all of them when the
 * search fails. Returns a map from branch name → PRs across repos.
 */
export async function fetchAllPullRequests(
  repos: Record<string, string>,
  deps: PrListDeps = defaultPrListDeps(),
): Promise<{ map: BranchPrMap; incomplete: string[] }> {
  const entries = Object.entries(repos);
  const onGithub = new Map<string, string[]>(); // owner/name → its aliases
  const elsewhere: Array<[string, string]> = [];
  for (const [alias, repoPath] of entries) {
    const text = deps.gitConfig(repoPath);
    const gh = text ? githubRepoOf(text) : null;
    if (gh) onGithub.set(gh, [...(onGithub.get(gh) ?? []), alias]);
    else elsewhere.push([alias, repoPath]);
  }

  const results: Array<PullRequestInfo[] | null> = [];
  const incomplete: string[] = [];
  if (onGithub.size) {
    const out = await deps.search();
    const parsed = out ? readSearch(out, (repo) => onGithub.get(repo.toLowerCase()) ?? []) : null;
    if (parsed) {
      results.push(parsed.prs);
      if (parsed.incomplete) incomplete.push(...[...onGithub.values()].flat());
    } else {
      // gh can't search (an old gh, no network): the old way, repo by repo.
      const asked = new Set(elsewhere.map(([a]) => a));
      for (const [alias, repoPath] of entries) if (!asked.has(alias)) elsewhere.push([alias, repoPath]);
    }
  }
  const listed = await Promise.all(elsewhere.map(([alias, repoPath]) => deps.listRepo(repoPath, alias)));
  results.push(...listed);
  // Repos whose list may be missing PRs: gh failed, or it hit the limit.
  incomplete.push(...elsewhere.filter((_, i) => listed[i] === null || listed[i]!.length >= PR_LIST_LIMIT).map(([alias]) => alias));

  const map: BranchPrMap = new Map();
  for (const prList of results) {
    for (const pr of prList ?? []) {
      const existing = map.get(pr.branch);
      if (existing) {
        existing.push(pr);
      } else {
        map.set(pr.branch, [pr]);
      }
    }
  }

  return { map, incomplete };
}
