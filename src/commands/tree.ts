import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';
import { setupWorktree } from '../core/worktree.js';
import { getAiTool } from '../core/ai-launcher.js';
import { getCurrentBranch } from '../core/git.js';
import { upsertSession } from '../core/history.js';
import { openVSCode, launchAi } from '../utils/platform.js';

export const treeCommand: CommandModule = {
  command: ['tree <target> [branch]', 't <target> [branch]'],
  describe: 'Create or switch to a worktree and launch the configured AI tool',
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
        describe: 'Launch the AI tool with its skip-permissions flag (default: --dangerously-skip-permissions)',
        type: 'boolean',
        default: false,
      })
      .option('base', {
        describe: 'Create the new branch from this base branch instead of HEAD',
        type: 'string',
      })
      .option('prompt', {
        describe: 'Initial prompt to send to the AI tool on startup',
        type: 'string',
      })
      .option('prompt-file', {
        describe: 'File containing the initial prompt (deleted after reading)',
        type: 'string',
      })
      .option('jira-key', {
        describe: 'Link a Jira issue key to this worktree session',
        type: 'string',
        hidden: true,
      })
      .option('setup-only', {
        describe: 'Create worktree without launching the AI tool (used by dashboard)',
        type: 'boolean',
        default: false,
        hidden: true,
      }),
  handler: async (argv) => {
    const targetName = argv.target as string;
    const branchName = argv.branch as string | undefined;
    const open = argv.open as boolean;
    const unsafe = argv.unsafe as boolean;
    const setupOnly = argv['setup-only'] as boolean;
    const baseBranch = argv.base as string | undefined;
    const jiraKey = argv['jira-key'] as string | undefined;
    const promptFile = argv['prompt-file'] as string | undefined;
    let initialPrompt = argv.prompt as string | undefined;

    // --prompt-file takes precedence: read and delete the temp file
    if (promptFile) {
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
          `Usage: work tree ${targetName} <branch> --base ${baseBranch}`,
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
          'Add a new project with: work config add <alias> <path>',
        ),
      );
      process.exitCode = 1;
      return;
    }

    // No branch specified — work directly on the base repo
    if (!branchName) {
      if (target.isGroup) {
        console.error('Branch is required for group targets.');
        console.log(chalk.yellow(`Usage: work tree ${targetName} <branch>`));
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

      const currentBranch = getCurrentBranch(repoPath) ?? '(detached)';
      await upsertSession(targetName, false, currentBranch, [repoPath], jiraKey);

      if (open) openVSCode(repoPath);
      if (!setupOnly) {
        const tool = getAiTool(config);
        console.log(`Starting ${tool.cmd}...`);
        launchAi(repoPath, tool, { unsafe, initialPrompt });
      }
      return;
    }

    // Create/switch worktree via shared core logic
    const result = await setupWorktree(targetName, branchName, config, baseBranch, jiraKey);
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
    if (!setupOnly) {
      const tool = getAiTool(config);
      console.log(`Starting ${tool.cmd}...`);
      launchAi(result.launchDir, tool, { unsafe, initialPrompt });
    }
  },
};
