import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import {
  type PrunableEntry,
  collectPrunable,
  removeSingleEntry,
  removeGroupEntry,
} from '../core/prunable-scan.js';

export const pruneCommand: CommandModule = {
  command: 'prune',
  describe: 'Remove worktrees for merged branches',
  builder: (yargs) =>
    yargs.option('force', {
      describe: 'Skip interactive picker and remove all merged worktrees',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    const force = argv.force as boolean;

    const config = ensureConfig();
    console.log(chalk.gray('Scanning worktrees for merged branches...\n'));
    const prunable = collectPrunable(config);

    if (prunable.length === 0) {
      console.log(chalk.green('No merged worktrees found. Nothing to prune.'));
      return;
    }

    console.log(
      chalk.cyan(`Found ${prunable.length} merged worktree(s):\n`),
    );

    let selected: PrunableEntry[];

    if (force) {
      selected = prunable;
      for (const entry of selected) {
        const suffix = entry.type === 'group' ? ' [group]' : '';
        console.log(`  ${entry.target}: ${entry.branch}${suffix}`);
      }
      console.log('');
    } else {
      const choices = prunable.map((entry) => {
        const suffix = entry.type === 'group' ? ' [group]' : '';
        return {
          name: `${entry.target}: ${entry.branch}${suffix}`,
          value: entry,
        };
      });

      selected = await checkbox({
        message: 'Select merged worktrees to remove',
        choices,
        pageSize: choices.length,
      });

      if (selected.length === 0) {
        console.log(chalk.yellow('Nothing selected.'));
        return;
      }

      console.log('');
    }

    for (const entry of selected) {
      if (entry.type === 'single') {
        await removeSingleEntry(entry);
      } else {
        await removeGroupEntry(entry, config);
      }
    }

    console.log('');
    console.log(chalk.green(`Pruned ${selected.length} worktree(s).`));
  },
};
