import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { fetchRemoteAsync } from '../core/git.js';
import {
  collectPrunable,
  removeSingleEntry,
  removeGroupEntry,
} from '../core/prunable-scan.js';

export const syncCommand: CommandModule = {
  command: 'sync',
  describe: 'Fetch all repos in parallel and prune merged worktrees (non-interactive)',
  builder: (yargs) =>
    yargs
      .option('dry-run', {
        describe: 'Show what would be pruned without removing anything',
        type: 'boolean',
        default: false,
      })
      .option('force', {
        describe: 'Skip dirty-tree safety checks when removing (default: true)',
        type: 'boolean',
        default: true,
      }),
  handler: async (argv) => {
    const dryRun = argv['dryRun'] as boolean;

    const config = ensureConfig();

    // Fetch all configured repos in parallel so merge checks use fresh refs.
    const repoEntries = Object.entries(config.repos).filter(([, repoPath]) =>
      fs.existsSync(repoPath),
    );

    if (repoEntries.length > 0) {
      console.log(chalk.gray(`Fetching ${repoEntries.length} repo(s)...`));
      await Promise.all(
        repoEntries.map(async ([alias, repoPath]) => {
          try {
            await fetchRemoteAsync(repoPath);
          } catch (err) {
            console.log(
              chalk.yellow(
                `  Warning: fetch failed for ${alias}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          }
        }),
      );
      console.log('');
    }

    console.log(chalk.gray('Scanning worktrees for merged branches...\n'));
    // We already fetched in parallel above; skip the serial fetch in collect.
    const prunable = collectPrunable(config, { fetch: false });

    if (prunable.length === 0) {
      console.log(chalk.green('No merged worktrees found. Everything is in sync.'));
      return;
    }

    console.log(chalk.cyan(`Found ${prunable.length} merged worktree(s):\n`));
    for (const entry of prunable) {
      const suffix = entry.type === 'group' ? ' [group]' : '';
      console.log(`  ${entry.target}: ${entry.branch}${suffix}`);
    }
    console.log('');

    if (dryRun) {
      console.log(
        chalk.yellow(`Dry run: would prune ${prunable.length} worktree(s). Nothing removed.`),
      );
      return;
    }

    let removed = 0;
    let failed = 0;
    for (const entry of prunable) {
      try {
        if (entry.type === 'single') {
          await removeSingleEntry(entry);
        } else {
          await removeGroupEntry(entry, config);
        }
        removed++;
      } catch (err) {
        failed++;
        console.log(
          chalk.red(
            `  Failed to remove ${entry.target}: ${entry.branch} — ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    }

    console.log('');
    console.log(chalk.green(`Pruned ${removed} worktree(s).`));
    if (failed > 0) {
      console.log(chalk.red(`Failed to remove ${failed} worktree(s).`));
      process.exitCode = 1;
    }
  },
};
