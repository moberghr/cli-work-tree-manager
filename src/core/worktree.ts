import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { debug } from './logger.js';
import type { WorkConfig } from './config.js';
import { getConfigDir } from './config.js';
import { resolveProjectTarget } from './resolve.js';
import { upsertSession } from './history.js';
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
  debug('createSingleWorktree', { repoPath, worktreePath, branchName, baseBranch });

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
  let branchSource: 'local' | 'remote' | 'new' = 'new';
  if (hasLocal || hasRemote) {
    if (hasRemote && !hasLocal) {
      branchSource = 'remote';
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
      branchSource = 'local';
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
    debug('git worktree add failed', { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
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

  if (branchSource === 'remote') {
    console.log(chalk.cyan(`  Tracking remote branch origin/${branchName}`));
  } else if (branchSource === 'local') {
    console.log(chalk.cyan(`  Using existing local branch ${branchName}`));
  } else if (baseBranch) {
    console.log(chalk.cyan(`  Created new branch ${branchName} from ${baseBranch}`));
  } else {
    console.log(chalk.cyan(`  Created new branch ${branchName}`));
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

/**
 * Result of setupWorktree — everything needed to launch an AI session.
 */
export interface WorktreeSetupResult {
  /** Directory to launch the AI tool in. */
  launchDir: string;
  /** All worktree paths created/found (for session tracking). */
  paths: string[];
  /** Whether the target is a group. */
  isGroup: boolean;
}

/**
 * High-level worktree setup: resolve target, create worktree(s), copy group
 * CLAUDE.md, and record the session. Used by both the CLI command and the TUI.
 *
 * Returns the setup result on success, or null on failure.
 */
export function setupWorktree(
  targetName: string,
  branchName: string,
  config: WorkConfig,
  baseBranch?: string,
  jiraKey?: string,
): WorktreeSetupResult | null {
  debug('setupWorktree', { targetName, branchName, baseBranch, jiraKey });
  const target = resolveProjectTarget(targetName, config);
  if (!target) { debug('setupWorktree: target not found', targetName); return null; }

  const workTreeDirName = branchName.replace(/\//g, '-');

  if (target.isGroup) {
    return setupGroupWorktree(target.name, target.repoAliases, branchName, workTreeDirName, config, baseBranch, jiraKey);
  } else {
    return setupSingleWorktree(targetName, branchName, workTreeDirName, config, baseBranch, jiraKey);
  }
}

function setupGroupWorktree(
  groupName: string,
  repoAliases: string[],
  branchName: string,
  workTreeDirName: string,
  config: WorkConfig,
  baseBranch?: string,
  jiraKey?: string,
): WorktreeSetupResult | null {
  const groupWorktreePath = path.join(config.worktreesRoot, groupName, workTreeDirName);

  // Pre-validate --base across all repos before creating anything
  if (baseBranch) {
    const missingBase: string[] = [];
    const branchExists: string[] = [];

    for (const alias of repoAliases) {
      const repoPath = config.repos[alias];
      if (!localBranchExists(baseBranch, repoPath) && !remoteBranchExists(baseBranch, repoPath)) {
        missingBase.push(alias);
      }
      if (localBranchExists(branchName, repoPath) || remoteBranchExists(branchName, repoPath)) {
        branchExists.push(alias);
      }
    }

    if (missingBase.length > 0) {
      console.error(`Base branch '${baseBranch}' not found in: ${missingBase.join(', ')}`);
      return null;
    }
    if (branchExists.length > 0) {
      console.error(`Cannot use --base: branch '${branchName}' already exists in: ${branchExists.join(', ')}`);
      return null;
    }
  }

  console.log(chalk.cyan(`Creating group worktree: ${groupName}/${branchName}`));
  console.log(chalk.gray(`Directory: ${groupWorktreePath}`));
  console.log('');

  fs.mkdirSync(groupWorktreePath, { recursive: true });

  const createdWorktrees: Array<{ repoPath: string; worktreePath: string }> = [];

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const subWorktreePath = path.join(groupWorktreePath, repoName);

    console.log(chalk.cyan(`[${alias}] (${repoName}):`));
    const success = createSingleWorktree(repoPath, subWorktreePath, branchName, config, baseBranch);

    if (success) {
      createdWorktrees.push({ repoPath, worktreePath: subWorktreePath });
    } else {
      // Rollback
      console.log('');
      console.log(chalk.yellow('Rolling back created worktrees due to failure...'));
      for (const wt of createdWorktrees) {
        removeSingleWorktree(wt.repoPath, wt.worktreePath, branchName, true);
      }
      try {
        if (fs.readdirSync(groupWorktreePath).length === 0) {
          fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        }
      } catch { /* */ }
      console.error('Failed to create group worktree. Changes have been rolled back.');
      return null;
    }
  }

  // Copy group CLAUDE.md
  const configDir = getConfigDir();
  const claudeMdSrc = path.join(configDir, `${groupName}.claude.md`);
  const claudeMdDest = path.join(groupWorktreePath, 'CLAUDE.md');

  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    console.log('');
    console.log(chalk.green('Copied group CLAUDE.md to worktree root'));
  } else {
    console.log('');
    console.log(chalk.yellow(`Warning: Group CLAUDE.md not found at ${claudeMdSrc}`));
    console.log(chalk.yellow(`Run 'work2 config regengroup ${groupName}' to generate it.`));
  }

  const allPaths = createdWorktrees.map((wt) => wt.worktreePath);
  upsertSession(groupName, true, branchName, allPaths, jiraKey);

  console.log('');
  console.log(`Branch: ${branchName}`);

  return { launchDir: groupWorktreePath, paths: allPaths, isGroup: true };
}

function setupSingleWorktree(
  targetName: string,
  branchName: string,
  workTreeDirName: string,
  config: WorkConfig,
  baseBranch?: string,
  jiraKey?: string,
): WorktreeSetupResult | null {
  const repoPath = config.repos[targetName];
  const repoName = path.basename(repoPath);
  let workTreePath = path.join(config.worktreesRoot, repoName, workTreeDirName);

  if (!fs.existsSync(repoPath)) {
    console.error(`Repository path does not exist: ${repoPath}`);
    return null;
  }

  // Check for existing worktree at any path
  const worktrees = parseWorktreeList(repoPath);
  const existing = worktrees.find((wt) => wt.branch === branchName);

  if (existing) {
    if (baseBranch) {
      console.error(`Cannot use --base: worktree for '${branchName}' already exists at ${existing.path}`);
      return null;
    }
    console.log(`Worktree already exists at: ${existing.path}`);
    workTreePath = existing.path;
  } else {
    const success = createSingleWorktree(repoPath, workTreePath, branchName, config, baseBranch);
    if (!success) return null;
  }

  upsertSession(targetName, false, branchName, [workTreePath], jiraKey);

  console.log(`Branch: ${branchName}`);

  return { launchDir: workTreePath, paths: [workTreePath], isGroup: false };
}

/**
 * Remove all worktrees for a session and clean up.
 * Returns true if all worktrees were successfully removed.
 * When force=false, stops on uncommitted/unpushed changes.
 */
export function teardownWorktree(
  target: string,
  isGroup: boolean,
  branch: string,
  config: WorkConfig,
  force: boolean = true,
): boolean {
  const workTreeDirName = branch.replace(/\//g, '-');

  if (isGroup && config.groups[target]) {
    const aliases = config.groups[target];
    const groupWorktreePath = path.join(config.worktreesRoot, target, workTreeDirName);
    let allRemoved = true;

    for (const alias of aliases) {
      const repoPath = config.repos[alias];
      if (!repoPath) continue;
      const repoName = path.basename(repoPath);
      const subWorktreePath = path.join(groupWorktreePath, repoName);
      console.log(chalk.cyan(`[${alias}] (${repoName}):`));
      if (!removeSingleWorktree(repoPath, subWorktreePath, branch, force)) {
        allRemoved = false;
      }
    }

    // Clean up group CLAUDE.md and empty parent dir
    const claudeMd = path.join(groupWorktreePath, 'CLAUDE.md');
    try { if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd); } catch { /* */ }
    try {
      if (fs.existsSync(groupWorktreePath) && fs.readdirSync(groupWorktreePath).length === 0) {
        fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        console.log(chalk.green(`Cleaned up group directory: ${groupWorktreePath}`));
      }
    } catch { /* */ }

    return allRemoved;
  } else {
    const repoPath = config.repos[target];
    if (repoPath) {
      const worktrees = parseWorktreeList(repoPath);
      const wt = worktrees.find((w) => w.branch === branch);
      if (wt) {
        return removeSingleWorktree(repoPath, wt.path, branch, force);
      }
    }
    return true;
  }
}
