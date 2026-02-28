import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { WorkConfig } from './config.js';
import {
  git,
  parseWorktreeList,
  localBranchExists,
  remoteBranchExists,
  isGitRepo,
  getCurrentBranch,
  getStatus,
  getUnpushedCommits,
} from './git.js';
import { copyConfigFiles } from './copy-files.js';

/**
 * Create a single git worktree for one repo.
 * Returns true on success, false on failure.
 *
 * When `baseBranch` is provided, the new branch is created from that base
 * instead of HEAD. Only valid for new branches — errors if the target branch
 * already exists locally or on remote.
 */
export function createSingleWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  config: WorkConfig,
  baseBranch?: string,
): boolean {
  // Check if the worktree already exists at the target path (idempotent re-run)
  if (fs.existsSync(worktreePath)) {
    if (isGitRepo(worktreePath)) {
      const currentBranch = getCurrentBranch(worktreePath);
      if (currentBranch === branchName) {
        console.log(
          chalk.yellow(`  Worktree already exists at: ${worktreePath}`),
        );
        return true;
      }
    }
  }

  // Check if the branch is already checked out in another worktree
  const worktrees = parseWorktreeList(repoPath);
  const existingForBranch = worktrees.find(
    (wt) => wt.branch === branchName && wt.path !== worktreePath,
  );

  if (existingForBranch) {
    console.log(
      chalk.red(
        `  Branch '${branchName}' is already checked out in a worktree at: ${existingForBranch.path}`,
      ),
    );
    console.log(
      chalk.red('  Remove that worktree first, or use the existing one.'),
    );
    return false;
  }

  // Create parent directory
  const parentDir = path.dirname(worktreePath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Pull latest changes for current branch in main repo
  console.log('  Pulling latest changes for main repo...');
  git(['pull', '--quiet'], repoPath);

  // Fetch remote refs
  git(['fetch', '--quiet'], repoPath);

  const hasLocal = localBranchExists(branchName, repoPath);
  const hasRemote = remoteBranchExists(branchName, repoPath);

  // --base requires a brand-new branch
  if (baseBranch && (hasLocal || hasRemote)) {
    console.log(
      chalk.red(
        `  Cannot use --base: branch '${branchName}' already exists ${hasLocal ? 'locally' : 'on remote'}`,
      ),
    );
    return false;
  }

  // Pull latest changes if branch exists locally
  if (hasLocal) {
    console.log(`  Pulling latest changes for ${branchName}...`);
    const prevBranch = getCurrentBranch(repoPath);
    git(['checkout', branchName, '--quiet'], repoPath);
    git(['pull', '--quiet'], repoPath);
    if (prevBranch) {
      git(['checkout', prevBranch, '--quiet'], repoPath);
    }
  }

  // Create worktree
  let result;
  if (hasLocal || hasRemote) {
    if (hasRemote && !hasLocal) {
      result = git(
        [
          'worktree',
          'add',
          worktreePath,
          '-b',
          branchName,
          '--track',
          `origin/${branchName}`,
        ],
        repoPath,
      );
    } else {
      result = git(
        ['worktree', 'add', worktreePath, branchName],
        repoPath,
      );
    }
  } else if (baseBranch) {
    // Validate the base branch exists
    const baseLocal = localBranchExists(baseBranch, repoPath);
    const baseRemote = remoteBranchExists(baseBranch, repoPath);

    if (!baseLocal && !baseRemote) {
      console.log(
        chalk.red(
          `  Base branch '${baseBranch}' does not exist locally or on remote`,
        ),
      );
      return false;
    }

    const baseRef = baseLocal ? baseBranch : `origin/${baseBranch}`;
    result = git(
      ['worktree', 'add', worktreePath, '-b', branchName, baseRef],
      repoPath,
    );
  } else {
    result = git(
      ['worktree', 'add', worktreePath, '-b', branchName],
      repoPath,
    );
  }

  if (result.exitCode !== 0) {
    console.log(chalk.red('  Failed to create worktree'));
    if (result.stderr) {
      console.log(chalk.red(`  ${result.stderr}`));
    }
    return false;
  }

  // Copy configuration files from main repo
  if (config.copyFiles && config.copyFiles.length > 0) {
    copyConfigFiles(repoPath, worktreePath, config.copyFiles);
  }

  console.log(chalk.green(`  Created worktree: ${worktreePath}`));
  return true;
}

/**
 * Remove a single git worktree.
 * Returns true on success, false if blocked (uncommitted/unpushed changes).
 */
export function removeSingleWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  force: boolean,
): boolean {
  if (!fs.existsSync(worktreePath)) {
    console.log(
      chalk.yellow(`  Worktree does not exist at: ${worktreePath}`),
    );
    return true; // Nothing to remove is success
  }

  // Check if it's a valid git worktree
  if (!isGitRepo(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    git(['worktree', 'prune'], repoPath);
    console.log(`  Removed invalid worktree directory: ${worktreePath}`);
    return true;
  }

  if (!force) {
    // Check for uncommitted changes
    const status = getStatus(worktreePath);
    if (status) {
      console.log(
        chalk.yellow(`  Uncommitted changes in: ${worktreePath}`),
      );
      console.log(status);
      return false;
    }

    // Check for unpushed commits
    const unpushed = getUnpushedCommits(worktreePath);
    if (unpushed) {
      console.log(
        chalk.yellow(`  Unpushed commits in: ${worktreePath}`),
      );
      console.log(unpushed);
      return false;
    }
  }

  const args = force
    ? ['worktree', 'remove', worktreePath, '--force']
    : ['worktree', 'remove', worktreePath];

  const result = git(args, repoPath);

  if (result.exitCode === 0) {
    console.log(chalk.green(`  Removed worktree: ${worktreePath}`));
    return true;
  } else {
    console.log(chalk.red(`  Failed to remove worktree: ${worktreePath}`));
    if (result.stderr) {
      console.log(chalk.red(`  ${result.stderr}`));
    }
    return false;
  }
}
