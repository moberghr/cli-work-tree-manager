import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { parseWorktreeList } from '../core/git.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';
import {
  createSingleWorktree,
  removeSingleWorktree,
} from '../core/worktree.js';
import { openVSCode, launchClaude } from '../utils/platform.js';
import { upsertSession } from '../core/history.js';

export const treeCommand: CommandModule = {
  command: 'tree <target> [branch]',
  describe: 'Create or switch to a worktree and launch Claude Code',
  builder: (yargs) =>
    yargs
      .showHelpOnFail(true)
      .positional('target', {
        describe: 'Project alias or group name',
        type: 'string',
        demandOption: true,
      })
      .positional('branch', {
        describe: 'Branch name (e.g., feature/login). Omit to work on the base repo.',
        type: 'string',
      })
      .option('open', {
        describe: 'Open VS Code in the worktree after creation',
        type: 'boolean',
        default: false,
      })
      .option('unsafe', {
        describe: 'Launch Claude with --dangerously-skip-permissions',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) => {
    const targetName = argv.target as string;
    const branchName = argv.branch as string | undefined;
    const open = argv.open as boolean;
    const unsafe = argv.unsafe as boolean;

    const config = ensureConfig();

    // Resolve project target
    const target = resolveProjectTarget(targetName, config);
    if (!target) {
      const allNames = getAllTargetNames(config);
      console.error(`Project or group not found: ${targetName}`);
      console.log(chalk.yellow(`Available: ${allNames.join(', ')}`));
      console.log(
        chalk.yellow(
          'Add a new project with: work2 config add <alias> <path>',
        ),
      );
      process.exitCode = 1;
      return;
    }

    // No branch specified — work directly on the base repo
    if (!branchName) {
      handleBaseRepo(target, targetName, config, open, unsafe);
      return;
    }

    const worktreesRoot = config.worktreesRoot;
    const workTreeDirName = branchName.replace(/\//g, '-');

    if (target.isGroup) {
      handleGroupTree(
        target.name,
        target.repoAliases,
        branchName,
        workTreeDirName,
        worktreesRoot,
        config,
        open,
        unsafe,
      );
    } else {
      handleSingleTree(
        targetName,
        branchName,
        workTreeDirName,
        worktreesRoot,
        config,
        open,
        unsafe,
      );
    }
  },
};

function handleBaseRepo(
  target: NonNullable<ReturnType<typeof resolveProjectTarget>>,
  targetName: string,
  config: ReturnType<typeof ensureConfig>,
  open: boolean,
  unsafe: boolean,
): void {
  if (target.isGroup) {
    // For groups, launch Claude in each base repo? That doesn't make sense.
    // Just tell the user to specify a branch for groups.
    console.error('Branch is required for group targets.');
    console.log(
      chalk.yellow(`Usage: work2 tree ${targetName} <branch>`),
    );
    process.exitCode = 1;
    return;
  }

  const repoPath = config.repos[targetName];
  if (!fs.existsSync(repoPath)) {
    console.error(`Repository path does not exist: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(chalk.cyan(`Working on base repo: ${targetName}`));
  console.log(`Repo path: ${repoPath}`);

  if (open) {
    openVSCode(repoPath);
  }

  console.log('Starting Claude Code...');
  launchClaude(repoPath, unsafe);
}

function handleGroupTree(
  groupName: string,
  repoAliases: string[],
  branchName: string,
  workTreeDirName: string,
  worktreesRoot: string,
  config: ReturnType<typeof ensureConfig>,
  open: boolean,
  unsafe: boolean,
): void {
  const groupWorktreePath = path.join(
    worktreesRoot,
    groupName,
    workTreeDirName,
  );

  console.log(
    chalk.cyan(`Creating group worktree: ${groupName}/${branchName}`),
  );
  console.log(chalk.gray(`Directory: ${groupWorktreePath}`));
  console.log('');

  // Create parent directory
  fs.mkdirSync(groupWorktreePath, { recursive: true });

  const createdWorktrees: Array<{
    repoPath: string;
    worktreePath: string;
    branchName: string;
  }> = [];
  let allSuccess = true;

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const subWorktreePath = path.join(groupWorktreePath, repoName);

    console.log(chalk.cyan(`[${alias}] (${repoName}):`));
    const success = createSingleWorktree(
      repoPath,
      subWorktreePath,
      branchName,
      config,
    );

    if (success) {
      createdWorktrees.push({
        repoPath,
        worktreePath: subWorktreePath,
        branchName,
      });
    } else {
      allSuccess = false;
      break;
    }
  }

  if (!allSuccess) {
    // Rollback already-created worktrees
    console.log('');
    console.log(
      chalk.yellow('Rolling back created worktrees due to failure...'),
    );
    for (const wt of createdWorktrees) {
      removeSingleWorktree(wt.repoPath, wt.worktreePath, wt.branchName, true);
    }
    // Clean up empty parent dir
    try {
      const contents = fs.readdirSync(groupWorktreePath);
      if (contents.length === 0) {
        fs.rmSync(groupWorktreePath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    console.error(
      'Failed to create group worktree. Changes have been rolled back.',
    );
    process.exitCode = 1;
    return;
  }

  // Copy group CLAUDE.md to worktree root
  const configDir = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.work',
  );
  const groupClaudeMdSource = path.join(
    configDir,
    `${groupName}.claude.md`,
  );
  const groupClaudeMdDest = path.join(groupWorktreePath, 'CLAUDE.md');

  if (fs.existsSync(groupClaudeMdSource)) {
    fs.copyFileSync(groupClaudeMdSource, groupClaudeMdDest);
    console.log('');
    console.log(
      chalk.green('Copied group CLAUDE.md to worktree root'),
    );
  } else {
    console.log('');
    console.log(
      chalk.yellow(
        `Warning: Group CLAUDE.md not found at ${groupClaudeMdSource}`,
      ),
    );
    console.log(
      chalk.yellow(
        `Run 'work2 config regengroup ${groupName}' to generate it.`,
      ),
    );
  }

  console.log('');
  console.log(`Branch: ${branchName}`);

  // Open VS Code if requested
  if (open) {
    for (const alias of repoAliases) {
      const repoPath = config.repos[alias];
      const repoName = path.basename(repoPath);
      const subWorktreePath = path.join(groupWorktreePath, repoName);
      openVSCode(subWorktreePath);
    }
  }

  // Track session
  const allPaths = createdWorktrees.map((wt) => wt.worktreePath);
  upsertSession(groupName, true, branchName, allPaths);

  // Launch Claude in the group root
  console.log(`Worktree path: ${groupWorktreePath}`);
  console.log('Starting Claude Code...');
  launchClaude(groupWorktreePath, unsafe);
}

function handleSingleTree(
  targetName: string,
  branchName: string,
  workTreeDirName: string,
  worktreesRoot: string,
  config: ReturnType<typeof ensureConfig>,
  open: boolean,
  unsafe: boolean,
): void {
  const repoPath = config.repos[targetName];
  const repoName = path.basename(repoPath);
  let workTreePath = path.join(worktreesRoot, repoName, workTreeDirName);

  if (!fs.existsSync(repoPath)) {
    console.error(`Repository path does not exist: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  // Check for existing worktree at any path (backward compat: reuse wherever it is)
  const worktrees = parseWorktreeList(repoPath);
  const existing = worktrees.find((wt) => wt.branch === branchName);

  if (existing) {
    console.log(`Worktree already exists at: ${existing.path}`);
    workTreePath = existing.path;
  } else {
    const success = createSingleWorktree(
      repoPath,
      workTreePath,
      branchName,
      config,
    );
    if (!success) {
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Branch: ${branchName}`);

  // Open VS Code if requested
  if (open) {
    openVSCode(workTreePath);
  }

  upsertSession(targetName, false, branchName, [workTreePath]);

  console.log(`Worktree path: ${workTreePath}`);
  console.log('Starting Claude Code...');
  launchClaude(workTreePath, unsafe);
}
