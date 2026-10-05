import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { input, confirm, select, checkbox } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import { loadConfig, saveConfig, getConfigPath } from '../core/platform/config.js';
import { isGitRepo } from '../core/git/git.js';
import { KNOWN_TOOLS } from '../core/platform/ai-launcher.js';
import { setupCompletions, printCompletionResults, printManualInstructions } from './shared/setup-completions.js';
import { DEFAULT_COPY_FILES, suggestFolders } from '../core/setup/first-run.js';
import { enrollProblem, scanForRepos, suggestAlias } from '../core/worktree/repo-scan.js';

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
      console.log(chalk.yellow(`Configuration file already exists at: ${configPath}`));
      const overwrite = await confirm({
        message: 'Do you want to reconfigure? This will keep existing repos.',
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
        copyFiles: DEFAULT_COPY_FILES,
      };
    }

    // Configure worktrees root
    console.log(chalk.green('Where should all worktrees be created?'));
    const suggested = suggestFolders(os.homedir());
    const defaultRoot = config.worktreesRoot || suggested.worktreesRoot;

    const worktreesInput = await input({
      message: 'Worktrees root directory',
      default: defaultRoot,
    });

    config.worktreesRoot = worktreesInput || defaultRoot;

    console.log('');
    console.log(chalk.green(`Great! Worktrees will be created in: ${config.worktreesRoot}`));
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

    // Your repos: scan the folder they're in and tick the ones you work on.
    console.log(chalk.green('Where are your repositories?'));
    const reposFolder = (
      await input({ message: 'Folder with your repos', default: config.scanRoots?.[0] ?? suggested.reposFolder ?? '' })
    ).trim();
    if (reposFolder) {
      config.scanRoots = [path.resolve(reposFolder)];
      const found = scanForRepos(reposFolder, { skip: [config.worktreesRoot] }).filter(
        (r) => !Object.values(config!.repos).some((p) => path.resolve(p) === path.resolve(r.path)),
      );
      if (found.length) {
        const picked = await checkbox({
          message: `Found ${found.length} repo${found.length === 1 ? '' : 's'}: tick the ones you work on (space, then enter)`,
          choices: found.map((r) => ({ name: `${r.folder}${r.origin ? chalk.gray(`  ${r.origin}`) : ''}`, value: r.path })),
          pageSize: 15,
        });
        for (const p of picked) {
          const alias = suggestAlias(p, (a) => a in config!.repos || a in config!.groups);
          const problem = enrollProblem(alias, p, config);
          if (problem) {
            console.log(chalk.yellow(`  Skipped ${p}: ${problem}`));
            continue;
          }
          config.repos[alias] = p;
          console.log(chalk.green(`  Added: ${alias} -> ${p}`));
        }
      } else console.log(chalk.gray(`  No git repos found in ${reposFolder}.`));
      console.log(chalk.gray("  (Later: the dashboard's Repos page, or `work config scan`.)"));
      console.log('');
    }

    let addMore = await confirm({ message: 'Add a repository by its path?', default: Object.keys(config.repos).length === 0 });
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
        console.log(chalk.red(`Path is not a git repository (or does not exist): ${repoPath}`));
        continue;
      }

      config.repos[alias.trim()] = repoPath.trim();
      console.log(chalk.green(`  Added: ${alias.trim()} -> ${repoPath.trim()}`));
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
        console.log(chalk.gray('  Restart your shell for completions to take effect.'));
      } else {
        printManualInstructions();
      }
    }

    console.log('');
    console.log(chalk.cyan("You're all set! Try: work tree <project> <branch>"));
    console.log('');
  },
};
