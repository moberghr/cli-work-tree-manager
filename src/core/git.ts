import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { debug } from './logger.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a git command synchronously in the given cwd. */
export function git(args: string[], cwd: string): GitResult {
  debug('git', args.join(' '), `cwd=${cwd}`);
  const result = spawn.sync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // Avoid flashing a console window on Windows for every git call —
    // matters most when this runs inside the detached `wd --watch` daemon.
    windowsHide: true,
  });

  const r = {
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
    exitCode: result.status ?? 1,
  };
  if (r.exitCode !== 0) {
    debug('git failed', { args, exitCode: r.exitCode, stderr: r.stderr });
  }
  return r;
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

/** Get the absolute toplevel of the worktree containing cwd, or null if not a repo. */
export function getWorktreeRoot(cwd: string): string | null {
  const result = git(['rev-parse', '--show-toplevel'], cwd);
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout;
}

/**
 * Get the MAIN repo working directory for a (possibly linked) worktree.
 * `--git-common-dir` points at the main repo's `.git` dir; the main repo root
 * is its parent when the basename is `.git`, otherwise the path itself.
 * Returns null on failure.
 */
export function getMainRepoRoot(cwd: string): string | null {
  const result = git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  const commonDir = result.stdout;
  if (path.basename(commonDir) === '.git') {
    return path.dirname(commonDir);
  }
  return commonDir;
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

/**
 * Result of checking a branch against a single base ref.
 *
 * 'merged' is a high-confidence true merge (the branch tip is reachable from
 * base via a merge/fast-forward). 'squash-merged' is the lower-confidence
 * heuristic match from {@link checkSquashMerged} — the branch's squashed patch
 * already appears in base, but there is no real merge commit linking the two.
 * Callers that prune unattended should treat 'squash-merged' as opt-in only.
 */
type MergeCheck = 'merged' | 'squash-merged' | 'stale' | 'unrelated';

/**
 * Check if a branch is truly merged into a base ref (not just a stale branch
 * sitting behind base with no unique commits).
 *
 * Returns 'stale' if the branch tip is on the base's first-parent chain
 * (no unique work). Returns 'merged' if the branch has unique commits that
 * are all reachable from base. Returns 'squash-merged' if only the squash
 * heuristic matched. Returns 'unrelated' otherwise.
 */
function checkMergeStatus(branch: string, baseRef: string, cwd: string): MergeCheck {
  // 1. Branch must be an ancestor of base (all its commits are in base)
  const branchInBase = git(['merge-base', '--is-ancestor', branch, baseRef], cwd);
  if (branchInBase.exitCode !== 0) {
    // Not a regular merge — check for squash merge (low-confidence heuristic).
    if (checkSquashMerged(branch, baseRef, cwd)) return 'squash-merged';
    return 'unrelated';
  }

  // 2. If base is also ancestor of branch, they're at the same commit
  //    (fast-forward merge or empty branch) — nothing left to merge.
  const baseInBranch = git(['merge-base', '--is-ancestor', baseRef, branch], cwd);
  if (baseInBranch.exitCode === 0) return 'merged';

  // 3. Branch is ancestor of base — but is it on the main line (stale) or
  //    only reachable via a merge commit (truly merged)?
  //    A stale branch's tip sits directly on the first-parent chain.
  const tip = git(['rev-parse', branch], cwd);
  if (tip.exitCode !== 0) return 'unrelated';
  const mainLine = git(['rev-list', '--first-parent', '-n', '500', baseRef], cwd);
  if (mainLine.exitCode === 0 && mainLine.stdout.includes(tip.stdout)) {
    return 'stale';
  }

  return 'merged';
}

/**
 * Detect squash merges by creating a temporary dangling commit that represents
 * the branch's tree squashed onto the merge-base, then checking if that patch
 * is already present in the base ref via `git cherry`.
 */
function checkSquashMerged(branch: string, baseRef: string, cwd: string): boolean {
  const mb = git(['merge-base', baseRef, branch], cwd);
  if (mb.exitCode !== 0) return false;

  const tree = git(['rev-parse', `${branch}^{tree}`], cwd);
  if (tree.exitCode !== 0) return false;

  const dangling = git(['commit-tree', tree.stdout, '-p', mb.stdout, '-m', ''], cwd);
  if (dangling.exitCode !== 0) return false;

  const cherry = git(['cherry', baseRef, dangling.stdout], cwd);
  if (cherry.exitCode !== 0) return false;

  // If the output starts with "-", the patch is already in baseRef (squash-merged)
  return cherry.stdout.startsWith('-');
}

/** Confidence level for a positive merge result. */
export type MergeConfidence = 'merged' | 'squash-merged';

export interface MergeCheckResult {
  merged: boolean;
  /** The base ref it matched against (e.g. "origin/main"), or null if not merged. */
  into: string | null;
  /**
   * How the match was determined when `merged` is true: 'merged' is a
   * high-confidence true merge; 'squash-merged' is the lower-confidence
   * squash heuristic. Null when not merged.
   */
  confidence: MergeConfidence | null;
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
      const status = checkMergeStatus(branch, baseRef, cwd);
      if (status === 'merged') return { merged: true, into: baseRef, confidence: 'merged' };
      if (status === 'squash-merged')
        return { merged: true, into: baseRef, confidence: 'squash-merged' };
      if (status === 'stale') return { merged: false, into: null, confidence: null };
    }

    // Fall back to local base branch
    if (localBranchExists(base, cwd)) {
      const status = checkMergeStatus(branch, base, cwd);
      if (status === 'merged') return { merged: true, into: base, confidence: 'merged' };
      if (status === 'squash-merged')
        return { merged: true, into: base, confidence: 'squash-merged' };
      if (status === 'stale') return { merged: false, into: null, confidence: null };
    }
  }

  return { merged: false, into: null, confidence: null };
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
    execFile(
      'git',
      ['fetch', '--quiet'],
      { cwd, timeout: 30000, windowsHide: true },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
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
  const conflicts = (result.stdout.match(/^<<<<<<< /gm) || []).length;
  return conflicts;
}

/**
 * Run a git command asynchronously in the given cwd. Mirrors {@link git} but
 * never blocks the event loop — use from interactive UIs (the TUI dashboard).
 */
export function gitAsync(args: string[], cwd: string): Promise<GitResult> {
  debug('gitAsync', args.join(' '), `cwd=${cwd}`);
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf-8', timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        const r = {
          stdout: (stdout ?? '').toString().trim(),
          stderr: (stderr ?? '').toString().trim(),
          exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined) ?? 1 : 0,
        };
        if (typeof r.exitCode !== 'number') r.exitCode = 1;
        if (r.exitCode !== 0) {
          debug('gitAsync failed', { args, exitCode: r.exitCode, stderr: r.stderr });
        }
        resolve(r);
      },
    );
  });
}

async function getDefaultBranchAsync(cwd: string): Promise<string | null> {
  const result = await gitAsync(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (result.exitCode === 0 && result.stdout) {
    return result.stdout.replace(/^refs\/remotes\/origin\//, '');
  }
  return null;
}

async function refExistsAsync(ref: string, cwd: string): Promise<boolean> {
  return (await gitAsync(['rev-parse', '--verify', ref], cwd)).exitCode === 0;
}

/** Async mirror of {@link checkSquashMerged}. */
async function checkSquashMergedAsync(branch: string, baseRef: string, cwd: string): Promise<boolean> {
  const mb = await gitAsync(['merge-base', baseRef, branch], cwd);
  if (mb.exitCode !== 0) return false;

  const tree = await gitAsync(['rev-parse', `${branch}^{tree}`], cwd);
  if (tree.exitCode !== 0) return false;

  const dangling = await gitAsync(['commit-tree', tree.stdout, '-p', mb.stdout, '-m', ''], cwd);
  if (dangling.exitCode !== 0) return false;

  const cherry = await gitAsync(['cherry', baseRef, dangling.stdout], cwd);
  if (cherry.exitCode !== 0) return false;

  return cherry.stdout.startsWith('-');
}

/** Async mirror of {@link checkMergeStatus}. */
async function checkMergeStatusAsync(branch: string, baseRef: string, cwd: string): Promise<MergeCheck> {
  const branchInBase = await gitAsync(['merge-base', '--is-ancestor', branch, baseRef], cwd);
  if (branchInBase.exitCode !== 0) {
    if (await checkSquashMergedAsync(branch, baseRef, cwd)) return 'squash-merged';
    return 'unrelated';
  }

  const baseInBranch = await gitAsync(['merge-base', '--is-ancestor', baseRef, branch], cwd);
  if (baseInBranch.exitCode === 0) return 'merged';

  const tip = await gitAsync(['rev-parse', branch], cwd);
  if (tip.exitCode !== 0) return 'unrelated';
  const mainLine = await gitAsync(['rev-list', '--first-parent', '-n', '500', baseRef], cwd);
  if (mainLine.exitCode === 0 && mainLine.stdout.includes(tip.stdout)) {
    return 'stale';
  }

  return 'merged';
}

/** Async mirror of {@link isBranchMerged} — non-blocking, for interactive UIs. */
export async function isBranchMergedAsync(
  branch: string,
  cwd: string,
  baseBranch?: string,
): Promise<MergeCheckResult> {
  const defaultBranch = await getDefaultBranchAsync(cwd);
  const bases = baseBranch
    ? [baseBranch]
    : [defaultBranch, 'main', 'master'].filter(
        (b): b is string => b !== null,
      );
  const uniqueBases = [...new Set(bases)];

  for (const base of uniqueBases) {
    if (await refExistsAsync(`origin/${base}`, cwd)) {
      const baseRef = `origin/${base}`;
      const status = await checkMergeStatusAsync(branch, baseRef, cwd);
      if (status === 'merged') return { merged: true, into: baseRef, confidence: 'merged' };
      if (status === 'squash-merged')
        return { merged: true, into: baseRef, confidence: 'squash-merged' };
      if (status === 'stale') return { merged: false, into: null, confidence: null };
    }

    if (await refExistsAsync(base, cwd)) {
      const status = await checkMergeStatusAsync(branch, base, cwd);
      if (status === 'merged') return { merged: true, into: base, confidence: 'merged' };
      if (status === 'squash-merged')
        return { merged: true, into: base, confidence: 'squash-merged' };
      if (status === 'stale') return { merged: false, into: null, confidence: null };
    }
  }

  return { merged: false, into: null, confidence: null };
}

/** Async mirror of {@link countConflicts} — non-blocking, for interactive UIs. */
export async function countConflictsAsync(branch: string, cwd: string): Promise<number> {
  const defaultBranch = (await getDefaultBranchAsync(cwd)) ?? 'main';
  const base = (await refExistsAsync(`origin/${defaultBranch}`, cwd))
    ? `origin/${defaultBranch}`
    : defaultBranch;

  const mergeBase = await gitAsync(['merge-base', base, branch], cwd);
  if (mergeBase.exitCode !== 0) return 0;

  const result = await gitAsync(['merge-tree', mergeBase.stdout, base, branch], cwd);
  const conflicts = (result.stdout.match(/^<<<<<<< /gm) || []).length;
  return conflicts;
}

/**
 * Async mirror of {@link rebaseOntoMain} — non-blocking (includes a network
 * fetch, so the sync version can freeze an interactive UI for seconds).
 * Returns error message or null on success.
 */
export async function rebaseOntoMainAsync(branch: string, cwd: string): Promise<string | null> {
  const defaultBranch = (await getDefaultBranchAsync(cwd)) ?? 'main';
  await gitAsync(['fetch', '--quiet'], cwd);
  const base = (await refExistsAsync(`origin/${defaultBranch}`, cwd))
    ? `origin/${defaultBranch}`
    : defaultBranch;
  const result = await gitAsync(['rebase', base, branch], cwd);
  if (result.exitCode !== 0) {
    await gitAsync(['rebase', '--abort'], cwd);
    return result.stderr || 'Rebase failed';
  }
  return null;
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
