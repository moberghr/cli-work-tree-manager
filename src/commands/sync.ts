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
        describe:
          'Force-remove worktrees with uncommitted changes or unpushed commits ' +
          '(default: false — such worktrees are skipped unless --force is given)',
        type: 'boolean',
        default: false,
      })
      .option('include-squash', {
        describe:
          'Also prune branches detected only via the squash-merge heuristic ' +
          '(default: false — unattended sync requires true-merge confidence)',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const dryRun = argv['dryRun'] as boolean;
    const force = argv['force'] as boolean;
    const includeSquash = argv['includeSquash'] as boolean;

    const config = ensureConfig();

    // Fetch all configured repos in parallel so merge checks use fresh refs.
    const repoEntries = Object.entries(config.repos).filter(([, repoPath]) =>
      fs.existsSync(repoPath),
    );

    // Repos whose fetch failed: their remote refs may be stale, so merge checks
    // are unreliable. Skip pruning any worktree backed by these repos.
    const skipAliases = new Set<string>();

    if (repoEntries.length > 0) {
      console.log(chalk.gray(`Fetching ${repoEntries.length} repo(s)...`));
      await Promise.all(
        repoEntries.map(async ([alias, repoPath]) => {
          try {
            await fetchRemoteAsync(repoPath);
          } catch (err) {
            skipAliases.add(alias);
            console.log(
              chalk.yellow(
                `  Warning: fetch failed for ${alias} — skipping prune for this ` +
                  `repo (refs may be stale): ${
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
    // print:false avoids double-printing the scan table — sync prints its own
    // summary below.
    const prunable = collectPrunable(config, {
      fetch: false,
      print: false,
      includeSquash,
      skipAliases,
    });

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
    let skippedDirty = 0;
    for (const entry of prunable) {
      // Safe by default: never force-remove a worktree with uncommitted
      // changes or unpushed commits unless --force was passed explicitly.
      if (entry.hasChanges && !force) {
        skippedDirty++;
        console.log(
          chalk.yellow(
            `  Skipping ${entry.target}: ${entry.branch} — uncommitted changes ` +
              `(pass --force to remove anyway).`,
          ),
        );
        continue;
      }

      try {
        const ok =
          entry.type === 'single'
            ? await removeSingleEntry(entry, force)
            : await removeGroupEntry(entry, config, force);
        if (ok) {
          removed++;
        } else {
          // Non-throwing failure (e.g. removeSingleWorktree refused or git
          // failed). Count it so process.exitCode is reliable for CI.
          failed++;
          console.log(
            chalk.red(
              `  Failed to remove ${entry.target}: ${entry.branch}`,
            ),
          );
        }
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
    if (skippedDirty > 0) {
      console.log(
        chalk.yellow(
          `Skipped ${skippedDirty} worktree(s) with local changes (use --force).`,
        ),
      );
    }
    if (failed > 0) {
      console.log(chalk.red(`Failed to remove ${failed} worktree(s).`));
      process.exitCode = 1;
    }
  },
};
