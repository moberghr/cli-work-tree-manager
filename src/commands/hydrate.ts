import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { hydrateHistoryFromDisk } from '../core/hydrate.js';

export const hydrateCommand: CommandModule = {
  command: 'hydrate',
  describe:
    'Scan worktreesRoot for existing worktrees and add untracked ones to history',
  builder: (yargs) => yargs,
  handler: async () => {
    const config = ensureConfig();
    const { discovered, added, updated } = await hydrateHistoryFromDisk(config);

    console.log('');
    console.log(chalk.cyan(`Discovered ${discovered} worktree(s) on disk.`));
    if (added > 0) {
      console.log(chalk.green(`Added ${added} new session(s) to history.`));
    }
    if (updated > 0) {
      console.log(chalk.yellow(`Updated paths for ${updated} session(s).`));
    }
    if (added === 0 && updated === 0) {
      console.log(chalk.gray('History already in sync with disk.'));
    }
  },
};
