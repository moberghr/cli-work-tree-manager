import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { input, confirm, select } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  type WorkConfig,
} from '../core/config.js';
import { isGitRepo } from '../core/git.js';
import { KNOWN_TOOLS } from '../core/ai-launcher.js';
import {
  setupCompletions,
  printCompletionResults,
  printManualInstructions,
} from '../core/setup-completions.js';

export const initCommand: CommandModule = {
  command: 'init',
  describe: 'Set up work configuration interactively',
  handler: async () => {
    console.log('');
    console.log(chalk.cyan('Welcome to Work - Git Worktree Manager'));
    console.log(chalk.cyan('======================================'));
    console.log('');

    const configPath = getConfigPath();
    let config = loadConfig();

    if (config) {
      console.log(
        chalk.yellow(
          `Configuration file already exists at: ${configPath}`,
        ),
      );
      const overwrite = await confirm({
        message:
          'Do you want to reconfigure? This will keep existing repos.',
        default: false,
      });

      if (!overwrite) {
        console.log('Initialization cancelled.');
        return;
      }
    }

    if (!config) {
      config = {
        worktreesRoot: '',
        repos: {},
        groups: {},
        copyFiles: [
          '*.Development.json',
          '*.Local.json',
          '.claude/settings.local.json',
        ],
      };
    }

    // Configure worktrees root
    console.log(chalk.green('Where should all worktrees be created?'));
    const defaultRoot =
      config.worktreesRoot ||
      path.join(path.dirname(os.homedir()), 'worktrees');

    const worktreesInput = await input({
      message: 'Worktrees root directory',
      default: defaultRoot,
    });

    config.worktreesRoot = worktreesInput || defaultRoot;

    console.log('');
    console.log(
      chalk.green(
        `Great! Worktrees will be created in: ${config.worktreesRoot}`,
      ),
    );
    console.log('');

    // AI tool selection
    console.log(chalk.green('Which AI tool should be launched in worktrees?'));
    const currentTool = (config.aiCommand ?? 'claude').trim().split(/\s+/)[0];
    const knownChoice = KNOWN_TOOLS.find((t) => t.value === currentTool);
    const toolChoice = await select<string>({
      message: 'AI tool',
      choices: [
        ...KNOWN_TOOLS.map((t) => ({ name: t.name, value: t.value })),
        { name: 'Custom (enter command manually)', value: '__custom__' },
      ],
      default: knownChoice ? knownChoice.value : '__custom__',
    });

    if (toolChoice === '__custom__') {
      const customCmd = await input({
        message: 'Command to launch (with any base args)',
        default: config.aiCommand ?? 'claude',
      });
      config.aiCommand = customCmd.trim() || 'claude';
    } else {
      config.aiCommand = toolChoice;
    }
    console.log(chalk.green(`AI tool set to: ${config.aiCommand}`));
    console.log('');

    // Add repositories
    console.log(chalk.green('Now let\'s add your repositories.'));
    console.log(
      chalk.gray('(You can add more later with: work2 config add <alias> <path>)'),
    );
    console.log('');

    let addMore = true;
    let repoCount = 1;

    while (addMore) {
      console.log(chalk.yellow(`Repository #${repoCount}:`));

      const alias = await input({
        message: "  Alias (short name, e.g., 'ai', 'frontend')",
      });

      if (!alias.trim()) {
        console.log(chalk.red('Alias cannot be empty. Skipping.'));
        continue;
      }

      const repoPath = await input({
        message: '  Repository path',
      });

      if (!repoPath.trim()) {
        console.log(chalk.red('Repository path cannot be empty. Skipping.'));
        continue;
      }

      // Validate path is a git repo
      if (!isGitRepo(repoPath)) {
        console.log(
          chalk.red(
            `Path is not a git repository (or does not exist): ${repoPath}`,
          ),
        );
        continue;
      }

      config.repos[alias.trim()] = repoPath.trim();
      console.log(
        chalk.green(`  Added: ${alias.trim()} -> ${repoPath.trim()}`),
      );
      console.log('');

      repoCount++;

      addMore = await confirm({
        message: 'Add another repository?',
        default: false,
      });
    }

    // Save configuration
    saveConfig(config);

    console.log('');
    console.log(chalk.green(`Configuration saved to: ${configPath}`));

    // Tab completions
    console.log('');
    console.log(chalk.green('Tab Completions'));
    const installCompletions = await confirm({
      message: 'Set up tab completions?',
      default: true,
    });

    if (installCompletions) {
      const results = setupCompletions();
      if (results.length > 0) {
        printCompletionResults(results);
        console.log('');
        console.log(
          chalk.gray('  Restart your shell for completions to take effect.'),
        );
      } else {
        printManualInstructions();
      }
    }

    console.log('');
    console.log(
      chalk.cyan('You\'re all set! Try: work2 tree <project> <branch>'),
    );
    console.log('');
  },
};
