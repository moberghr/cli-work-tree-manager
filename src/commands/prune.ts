import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/platform/config.js';
import { applyCleanup, scanCleanup } from '../core/cleanup/cleanup.js';
import { defaultCleanupDeps } from '../core/cleanup/cleanup-deps.js';
import type { CleanupCandidate } from '../core/api-types.js';
import { printCleanupResults, removable } from './shared/cleanup-print.js';

export const pruneCommand: CommandModule = {
  command: 'prune',
  describe: 'Remove worktrees that are merged (or never committed to), picking from a list',
  builder: (yargs) =>
    yargs.option('force', {
      describe: 'Skip the picker and remove every one that is safe to remove',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    const force = argv.force as boolean;
    ensureConfig();
    const deps = defaultCleanupDeps();
    console.log(chalk.gray('Fetching and checking worktrees…\n'));
    const scan = await scanCleanup(deps);
    for (const f of scan.fetchFailed) console.log(chalk.yellow(`  Could not fetch ${f.alias}; its worktrees were not checked: ${f.error}`));
    // Interactive prune is human-confirmed (you see the list and pick), so
    // squash-merged branches are offered too.
    const candidates = removable(scan.candidates, { includeSquash: true });
    if (candidates.length === 0) {
      console.log(chalk.green('Nothing to prune: no worktree is merged, clean and unused for a day.'));
      return;
    }
    const label = (c: CleanupCandidate) => `${c.target}: ${c.branch}${c.isGroup ? ' [group]' : ''} — ${c.reason}`;
    let selected: CleanupCandidate[];
    if (force) {
      selected = candidates;
      console.log(chalk.cyan(`Removing ${selected.length} worktree(s):`));
      for (const c of selected) console.log(`  ${label(c)}`);
    } else {
      selected = await checkbox({
        message: 'Select worktrees to remove (the branches are kept)',
        choices: candidates.map((c) => ({ name: label(c), value: c, checked: true })),
        pageSize: Math.min(candidates.length, 25),
      });
      if (selected.length === 0) {
        console.log(chalk.yellow('Nothing selected.'));
        return;
      }
    }
    console.log('');
    const results = await applyCleanup(
      deps,
      selected.map((c) => ({ sessionId: c.sessionId, action: c.verdict === 'gone' ? 'forget' : 'delete' })),
    );
    printCleanupResults(selected, results);
  },
};
