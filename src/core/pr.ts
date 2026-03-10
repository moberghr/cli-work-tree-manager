import { execFile } from 'node:child_process';

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  url: string;
  isDraft: boolean;
  checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
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

function parsePrJson(stdout: string, repoAlias: string): PullRequestInfo[] {
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

    results.push({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
      isDraft: pr.isDraft ?? false,
      checksStatus,
      repoAlias,
    });
  }

  return results;
}

/**
 * Fetch open PRs for a repo using `gh` CLI (async, non-blocking).
 */
async function fetchPullRequests(repoPath: string, repoAlias: string): Promise<PullRequestInfo[]> {
  try {
    const stdout = await execAsync(
      'gh',
      [
        'pr', 'list',
        '--state', 'open',
        '--json', 'number,title,headRefName,url,isDraft,statusCheckRollup',
        '--limit', '100',
      ],
      repoPath,
      15000,
    );
    if (!stdout) return [];
    return parsePrJson(stdout, repoAlias);
  } catch {
    return [];
  }
}

/**
 * Fetch PRs for all configured repos (async, non-blocking).
 * Runs all repo fetches in parallel.
 * Returns a map from branch name → array of PRs across repos.
 */
export async function fetchAllPullRequests(repos: Record<string, string>): Promise<BranchPrMap> {
  const entries = Object.entries(repos);
  const results = await Promise.all(
    entries.map(([alias, repoPath]) => fetchPullRequests(repoPath, alias)),
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
