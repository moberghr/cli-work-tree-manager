import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { applyCleanup, scanCleanup } from '../core/cleanup.js';
import { defaultCleanupDeps } from '../core/cleanup-deps.js';
import { printCleanupResults, removable } from './shared/cleanup-print.js';

export const syncCommand: CommandModule = {
  command: 'sync',
  describe: 'Fetch all repos and remove merged worktrees (non-interactive)',
  builder: (yargs) =>
    yargs
      .option('dry-run', {
        describe: 'Show what would be removed without removing anything',
        type: 'boolean',
        default: false,
      })
      .option('force', {
        describe:
          'Also remove merged worktrees that have uncommitted changes (those changes are lost). ' +
          'A worktree with commits the main branch lacks is never removed.',
        type: 'boolean',
        default: false,
      })
      .option('include-squash', {
        describe:
          'Also remove branches detected as squash-merged ' +
          '(default: false — unattended sync requires a true merge)',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const dryRun = argv['dryRun'] as boolean;
    const force = argv['force'] as boolean;
    const includeSquash = argv['includeSquash'] as boolean;
    ensureConfig();
    const deps = defaultCleanupDeps();

    console.log(chalk.gray('Fetching all repos and checking worktrees…\n'));
    const scan = await scanCleanup(deps);
    // A repo whose fetch failed has stale refs: its worktrees were not judged.
    for (const f of scan.fetchFailed) console.log(chalk.yellow(`  Warning: fetch failed for ${f.alias} — skipping it (refs may be stale): ${f.error}`));

    const chosen = removable(scan.candidates, { includeSquash, dirtyToo: force });
    const skippedDirty = removable(scan.candidates, { includeSquash, dirtyToo: true }).length - chosen.length;
    if (chosen.length === 0) {
      console.log(chalk.green('No merged worktrees to remove. Everything is in sync.'));
      if (skippedDirty > 0) console.log(chalk.yellow(`Skipped ${skippedDirty} merged worktree(s) with local changes (use --force).`));
      return;
    }
    console.log(chalk.cyan(`${dryRun ? 'Would remove' : 'Removing'} ${chosen.length} merged worktree(s):`));
    for (const c of chosen) console.log(`  ${c.target}: ${c.branch}${c.isGroup ? ' [group]' : ''} — ${c.reason}`);
    console.log('');
    if (dryRun) {
      console.log(chalk.yellow(`Dry run: nothing removed.`));
      return;
    }
    const results = await applyCleanup(
      deps,
      chosen.map((c) => ({ sessionId: c.sessionId, action: c.verdict === 'gone' ? ('forget' as const) : ('delete' as const) })),
      { force },
    );
    printCleanupResults(chosen, results);
    if (skippedDirty > 0) console.log(chalk.yellow(`Skipped ${skippedDirty} merged worktree(s) with local changes (use --force).`));
    // A removal that git refused is a failure for scripts; "changed since the
    // scan" is a safe skip, counted in the summary above.
    if (results.some((r) => !r.ok && r.message.startsWith('git refused'))) process.exitCode = 1;
  },
};
