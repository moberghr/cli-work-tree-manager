import { execFile } from 'node:child_process';

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
    execFile(
      cmd,
      args,
      { cwd, encoding: 'utf-8', timeout, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout ?? '');
      },
    );
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
}

function parsePrJson(stdout: string, repoAlias: string, currentUser: string): PullRequestInfo[] {
  const parsed = JSON.parse(stdout) as unknown;
  const prs: GhPr[] = Array.isArray(parsed) ? (parsed as GhPr[]) : [];
  const results: PullRequestInfo[] = [];

  for (const pr of prs) {
    let checksStatus: PullRequestInfo['checksStatus'] = 'NONE';
    const checks = pr.statusCheckRollup ?? [];
    if (checks.length > 0) {
      const hasFailure = checks.some((c) =>
        c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.conclusion === 'CANCELLED',
      );
      const hasPending = checks.some((c) =>
        c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING',
      );
      if (hasFailure) checksStatus = 'FAILURE';
      else if (hasPending) checksStatus = 'PENDING';
      else checksStatus = 'SUCCESS';
    }

    // Merge conflict overrides to failure
    if (pr.mergeable === 'CONFLICTING') checksStatus = 'FAILURE';

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

    results.push({
      number: pr.number ?? 0,
      title: pr.title ?? '',
      branch: pr.headRefName ?? '',
      url: pr.url ?? '',
      isDraft: pr.isDraft ?? false,
      checksStatus,
      reviewDecision,
      myReview,
      isMine: currentUser ? pr.author?.login?.toLowerCase() === currentUser.toLowerCase() : false,
      repoAlias,
    });
  }

  return results;
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
        'pr', 'list',
        '--state', 'open',
        '--json', 'number,title,headRefName,url,isDraft,statusCheckRollup,reviewDecision,reviews,mergeable,author',
        '--limit', String(PR_LIST_LIMIT),
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

export async function fetchAllPullRequests(repos: Record<string, string>): Promise<{ map: BranchPrMap; incomplete: string[] }> {
  const currentUser = await getCurrentUser();
  const entries = Object.entries(repos);
  const results = await Promise.all(
    entries.map(([alias, repoPath]) => fetchPullRequests(repoPath, alias, currentUser)),
  );

  // Repos whose list may be missing PRs: gh failed, or it hit the limit.
  const incomplete = entries.filter((_, i) => results[i] === null || results[i]!.length >= PR_LIST_LIMIT).map(([alias]) => alias);
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

