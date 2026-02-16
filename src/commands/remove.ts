import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';
import { removeSingleWorktree } from '../core/worktree.js';
import { removeSession } from '../core/history.js';

export const removeCommand: CommandModule = {
  command: 'remove <target> <branch>',
  describe: 'Remove a worktree',
  builder: (yargs) =>
    yargs
      .showHelpOnFail(true)
      .positional('target', {
        describe: 'Project alias or group name',
        type: 'string',
        demandOption: true,
      })
      .positional('branch', {
        describe: 'Branch name (e.g., feature/login)',
        type: 'string',
        demandOption: true,
      })
      .option('force', {
        describe: 'Force remove even with uncommitted/unpushed changes',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) => {
    const targetName = argv.target as string;
    const branchName = argv.branch as string;
    const force = argv.force as boolean;

    const config = ensureConfig();

    const target = resolveProjectTarget(targetName, config);
    if (!target) {
      const allNames = getAllTargetNames(config);
      console.error(`Project or group not found: ${targetName}`);
      console.log(chalk.yellow(`Available: ${allNames.join(', ')}`));
      process.exitCode = 1;
      return;
    }

    const worktreesRoot = config.worktreesRoot;
    const workTreeDirName = branchName.replace(/\//g, '-');

    if (target.isGroup) {
      handleGroupRemove(
        target.name,
        target.repoAliases,
        branchName,
        workTreeDirName,
        worktreesRoot,
        config,
        force,
      );
    } else {
      handleSingleRemove(
        targetName,
        branchName,
        workTreeDirName,
        worktreesRoot,
        config,
        force,
      );
    }
  },
};

function handleGroupRemove(
  groupName: string,
  repoAliases: string[],
  branchName: string,
  workTreeDirName: string,
  worktreesRoot: string,
  config: ReturnType<typeof ensureConfig>,
  force: boolean,
): void {
  const groupWorktreePath = path.join(
    worktreesRoot,
    groupName,
    workTreeDirName,
  );

  if (!fs.existsSync(groupWorktreePath)) {
    console.error(
      `Group worktree does not exist at: ${groupWorktreePath}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    chalk.cyan(`Removing group worktree: ${groupName}/${branchName}`),
  );
  console.log('');

  let allRemoved = true;

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const subWorktreePath = path.join(groupWorktreePath, repoName);

    console.log(chalk.cyan(`[${alias}] (${repoName}):`));
    const removed = removeSingleWorktree(
      repoPath,
      subWorktreePath,
      branchName,
      force,
    );
    if (!removed) {
      allRemoved = false;
    }
  }

  if (allRemoved) {
    removeSession(groupName, branchName);
  } else {
    console.log('');
    console.log(
      chalk.yellow(
        'Some worktrees could not be removed due to uncommitted/unpushed changes.',
      ),
    );
    console.log(
      chalk.yellow(
        `Use 'work2 remove ${groupName} ${branchName} --force' to force remove all.`,
      ),
    );
  }

  // Clean up CLAUDE.md in worktree
  const claudeMdInWorktree = path.join(groupWorktreePath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdInWorktree)) {
    fs.unlinkSync(claudeMdInWorktree);
  }

  // Remove parent dir only if empty
  try {
    if (fs.existsSync(groupWorktreePath)) {
      const contents = fs.readdirSync(groupWorktreePath);
      if (contents.length === 0) {
        fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        console.log(
          chalk.green(
            `Cleaned up group directory: ${groupWorktreePath}`,
          ),
        );
      }
    }
  } catch {
    // ignore
  }
}

function handleSingleRemove(
  targetName: string,
  branchName: string,
  workTreeDirName: string,
  worktreesRoot: string,
  config: ReturnType<typeof ensureConfig>,
  force: boolean,
): void {
  const repoPath = config.repos[targetName];
  const repoName = path.basename(repoPath);
  const workTreePath = path.join(worktreesRoot, repoName, workTreeDirName);

  if (!fs.existsSync(workTreePath)) {
    console.error(`Worktree does not exist at: ${workTreePath}`);
    process.exitCode = 1;
    return;
  }

  const removed = removeSingleWorktree(
    repoPath,
    workTreePath,
    branchName,
    force,
  );
  if (removed) {
    removeSession(targetName, branchName);
  } else {
    console.log('');
    console.log(
      chalk.yellow(
        `Use 'work2 remove ${targetName} ${branchName} --force' to force remove.`,
      ),
    );
  }
}
