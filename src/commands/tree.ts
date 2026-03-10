import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';
import { setupWorktree } from '../core/worktree.js';
import { openVSCode, launchClaude } from '../utils/platform.js';

export const treeCommand: CommandModule = {
  command: ['tree <target> [branch]', 't <target> [branch]'],
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
      })
      .option('base', {
        describe: 'Create the new branch from this base branch instead of HEAD',
        type: 'string',
      })
      .option('prompt', {
        describe: 'Initial prompt to send to Claude Code on startup',
        type: 'string',
      })
      .option('prompt-file', {
        describe: 'File containing the initial prompt (deleted after reading)',
        type: 'string',
      })
      .option('setup-only', {
        describe: 'Set up worktree only, do not launch the AI tool',
        type: 'boolean',
        default: false,
        hidden: true,
      }),
  handler: (argv) => {
    const targetName = argv.target as string;
    const branchName = argv.branch as string | undefined;
    const open = argv.open as boolean;
    const unsafe = argv.unsafe as boolean;
    const noLaunch = argv['setup-only'] as boolean;
    const baseBranch = argv.base as string | undefined;
    const promptFile = argv['prompt-file'] as string | undefined;
    let initialPrompt = argv.prompt as string | undefined;

    // --prompt-file takes precedence: read and delete the temp file
    // (skip when --setup-only since a subsequent launch will need the file)
    if (promptFile && !noLaunch) {
      try {
        initialPrompt = fs.readFileSync(promptFile, 'utf-8');
        fs.unlinkSync(promptFile);
      } catch {
        // ignore — fall through to --prompt or no prompt
      }
    }

    const config = ensureConfig();

    // --base requires a branch name
    if (baseBranch && !branchName) {
      console.error('--base requires a branch name');
      console.log(
        chalk.yellow(
          `Usage: work2 tree ${targetName} <branch> --base ${baseBranch}`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    // Resolve project target (for validation and base-repo handling)
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
      if (target.isGroup) {
        console.error('Branch is required for group targets.');
        console.log(chalk.yellow(`Usage: work2 tree ${targetName} <branch>`));
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
      if (open) openVSCode(repoPath);
      if (!noLaunch) {
        console.log('Starting Claude Code...');
        launchClaude(repoPath, unsafe, initialPrompt);
      }
      return;
    }

    // Create/switch worktree via shared core logic
    const result = setupWorktree(targetName, branchName, config, baseBranch);
    if (!result) {
      process.exitCode = 1;
      return;
    }

    if (open) {
      for (const p of result.paths) {
        openVSCode(p);
      }
    }

    console.log(`Worktree path: ${result.launchDir}`);
    if (!noLaunch) {
      console.log('Starting Claude Code...');
      launchClaude(result.launchDir, unsafe, initialPrompt);
    }
  },
};
