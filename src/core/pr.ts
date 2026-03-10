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
    execFile(cmd, args, { cwd, encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

function parsePrJson(stdout: string, repoAlias: string, currentUser: string): PullRequestInfo[] {
  const prs: any[] = JSON.parse(stdout);
  const results: PullRequestInfo[] = [];

  for (const pr of prs) {
    let checksStatus: PullRequestInfo['checksStatus'] = 'NONE';
    const checks: any[] = pr.statusCheckRollup ?? [];
    if (checks.length > 0) {
      const hasFailure = checks.some((c: any) =>
        c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.conclusion === 'CANCELLED',
      );
      const hasPending = checks.some((c: any) =>
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
      const reviews: any[] = pr.reviews ?? [];
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
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
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
async function fetchPullRequests(repoPath: string, repoAlias: string, currentUser: string): Promise<PullRequestInfo[]> {
  try {
    const stdout = await execAsync(
      'gh',
      [
        'pr', 'list',
        '--state', 'open',
        '--json', 'number,title,headRefName,url,isDraft,statusCheckRollup,reviewDecision,reviews,mergeable,author',
        '--limit', '100',
      ],
      repoPath,
      15000,
    );
    if (!stdout) return [];
    return parsePrJson(stdout, repoAlias, currentUser);
  } catch {
    return [];
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

export async function fetchAllPullRequests(repos: Record<string, string>): Promise<BranchPrMap> {
  const currentUser = await getCurrentUser();
  const entries = Object.entries(repos);
  const results = await Promise.all(
    entries.map(([alias, repoPath]) => fetchPullRequests(repoPath, alias, currentUser)),
  );

  const map: BranchPrMap = new Map();
  for (const prList of results) {
    for (const pr of prList) {
      const existing = map.get(pr.branch);
      if (existing) {
        existing.push(pr);
      } else {
        map.set(pr.branch, [pr]);
      }
    }
  }

  return map;
}

/** Check if `gh` CLI is available and authenticated (async). */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execAsync('gh', ['auth', 'status'], process.cwd(), 5000);
    return true;
  } catch {
    return false;
  }
}
