import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a git command synchronously in the given cwd. */
export function git(args: string[], cwd: string): GitResult {
  const result = spawn.sync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
    exitCode: result.status ?? 1,
  };
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
}

/** Parse `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeList(cwd: string): WorktreeEntry[] {
  const result = git(['worktree', 'list', '--porcelain'], cwd);
  if (result.exitCode !== 0) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of result.stdout.split('\n')) {
    const worktreeMatch = line.match(/^worktree (.+)$/);
    if (worktreeMatch) {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? '',
          head: current.head ?? '',
        });
      }
      current = { path: worktreeMatch[1] };
      continue;
    }

    const headMatch = line.match(/^HEAD (.+)$/);
    if (headMatch) {
      current.head = headMatch[1].substring(0, 7);
      continue;
    }

    const branchMatch = line.match(/^branch (.+)$/);
    if (branchMatch) {
      current.branch = branchMatch[1].replace(/^refs\/heads\//, '');
    }
  }

  // Push last entry
  if (current.path) {
    entries.push({
      path: current.path,
      branch: current.branch ?? '',
      head: current.head ?? '',
    });
  }

  return entries;
}

/** Check if a local branch exists. */
export function localBranchExists(branch: string, cwd: string): boolean {
  const result = git(['rev-parse', '--verify', branch], cwd);
  return result.exitCode === 0;
}

/** Check if a remote tracking branch exists. */
export function remoteBranchExists(branch: string, cwd: string): boolean {
  const result = git(['rev-parse', '--verify', `origin/${branch}`], cwd);
  return result.exitCode === 0;
}

/** Check if path is a valid git worktree/repo. */
export function isGitRepo(cwd: string): boolean {
  const result = git(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.exitCode === 0 && result.stdout === 'true';
}

/** Get current branch name. */
export function getCurrentBranch(cwd: string): string {
  const result = git(['branch', '--show-current'], cwd);
  return result.stdout;
}

/** Check for uncommitted changes (returns porcelain status). */
export function getStatus(cwd: string): string {
  const result = git(['status', '--porcelain'], cwd);
  return result.stdout;
}

/** Get the default branch from origin/HEAD (e.g. "main" or "master"). */
export function getDefaultBranch(cwd: string): string | null {
  const result = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (result.exitCode === 0 && result.stdout) {
    // Output is like "refs/remotes/origin/main"
    return result.stdout.replace(/^refs\/remotes\/origin\//, '');
  }
  return null;
}

export interface MergeCheckResult {
  merged: boolean;
  /** The base ref it matched against (e.g. "origin/main"), or null if not merged. */
  into: string | null;
}

export function isBranchMerged(
  branch: string,
  cwd: string,
  baseBranch?: string,
): MergeCheckResult {
  const defaultBranch = getDefaultBranch(cwd);
  const bases = baseBranch
    ? [baseBranch]
    : [defaultBranch, 'main', 'master'].filter(
        (b): b is string => b !== null,
      );

  // Deduplicate (e.g. default branch is "main" which is already in the list)
  const uniqueBases = [...new Set(bases)];

  for (const base of uniqueBases) {
    // Check remote base branch first (most up-to-date after fetch)
    if (remoteBranchExists(base, cwd)) {
      const baseRef = `origin/${base}`;
      const branchInBase = git(['merge-base', '--is-ancestor', branch, baseRef], cwd);
      if (branchInBase.exitCode === 0) {
        // Branch is ancestor of base — but if base is also ancestor of branch,
        // they're at the same commit (fresh branch, not actually merged)
        const baseInBranch = git(['merge-base', '--is-ancestor', baseRef, branch], cwd);
        if (baseInBranch.exitCode !== 0) return { merged: true, into: baseRef };
      }
    }

    // Fall back to local base branch
    if (localBranchExists(base, cwd)) {
      const branchInBase = git(['merge-base', '--is-ancestor', branch, base], cwd);
      if (branchInBase.exitCode === 0) {
        const baseInBranch = git(['merge-base', '--is-ancestor', base, branch], cwd);
        if (baseInBranch.exitCode !== 0) return { merged: true, into: base };
      }
    }
  }

  return { merged: false, into: null };
}

/** Fetch latest remote refs for a repo and ensure origin/HEAD is set. */
export function fetchRemote(cwd: string): void {
  git(['fetch', '--quiet'], cwd);

  // Ensure origin/HEAD is set so getDefaultBranch works
  if (!getDefaultBranch(cwd)) {
    git(['remote', 'set-head', 'origin', '--auto'], cwd);
  }
}

/** Async version of fetchRemote — non-blocking. */
export async function fetchRemoteAsync(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['fetch', '--quiet'], { cwd, timeout: 30000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  if (!getDefaultBranch(cwd)) {
    git(['remote', 'set-head', 'origin', '--auto'], cwd);
  }
}

/** Rebase a branch onto the default branch. Returns error message or null on success. */
export function rebaseOntoMain(branch: string, cwd: string): string | null {
  const defaultBranch = getDefaultBranch(cwd) ?? 'main';
  // Fetch latest first
  git(['fetch', '--quiet'], cwd);
  const base = remoteBranchExists(defaultBranch, cwd) ? `origin/${defaultBranch}` : defaultBranch;
  const result = git(['rebase', base, branch], cwd);
  if (result.exitCode !== 0) {
    // Abort the failed rebase
    git(['rebase', '--abort'], cwd);
    return result.stderr || 'Rebase failed';
  }
  return null;
}

/** Count merge conflicts between a branch and the default branch. Returns 0 if clean. */
export function countConflicts(branch: string, cwd: string): number {
  const defaultBranch = getDefaultBranch(cwd) ?? 'main';
  const base = remoteBranchExists(defaultBranch, cwd) ? `origin/${defaultBranch}` : defaultBranch;

  // Use merge-tree to simulate merge without changing worktree
  const mergeBase = git(['merge-base', base, branch], cwd);
  if (mergeBase.exitCode !== 0) return 0;

  const result = git(['merge-tree', mergeBase.stdout, base, branch], cwd);
  // Count conflict markers in merge-tree output
  const conflicts = (result.stdout.match(/^<<<<<<<$/gm) || []).length;
  return conflicts;
}

/** Check for unpushed commits. Returns the log output or empty string. */
export function getUnpushedCommits(cwd: string): string {
  const branch = getCurrentBranch(cwd);
  if (!branch) return '';

  const upstreamResult = git(
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    cwd,
  );
  if (upstreamResult.exitCode !== 0) return '';

  const upstream = upstreamResult.stdout;
  const logResult = git(['log', '--oneline', `${upstream}..HEAD`], cwd);
  return logResult.stdout;
}
