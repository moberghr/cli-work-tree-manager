import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import {
  loadHistory,
  saveHistory,
  getSessionsForTarget,
  pruneStaleEntries,
  type WorktreeSession,
} from '../core/history.js';
import {
  getStatus,
  getUnpushedCommits,
  isBranchMerged,
  getCurrentBranch,
} from '../core/git.js';
import { timeAgo, shortDateTime } from '../utils/format.js';

export const statusCommand: CommandModule = {
  command: 'status [target] [branch]',
  describe: 'Show status of tracked worktrees',
  builder: (yargs) =>
    yargs
      .positional('target', {
        describe: 'Filter by project alias or group name',
        type: 'string',
      })
      .positional('branch', {
        describe: 'Filter by branch name',
        type: 'string',
      })
      .option('prune', {
        describe: 'Remove entries whose worktree paths no longer exist',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) => {
    const target = argv.target as string | undefined;
    const branch = argv.branch as string | undefined;
    const prune = argv.prune as boolean;

    ensureConfig();

    let sessions = loadHistory();

    if (prune) {
      const { kept, pruned } = pruneStaleEntries(sessions);
      if (pruned > 0) {
        saveHistory(kept);
        console.log(chalk.green(`Pruned ${pruned} stale session(s).`));
      } else {
        console.log('No stale sessions to prune.');
      }
      sessions = kept;
    }

    if (target) {
      sessions = getSessionsForTarget(sessions, target);
    }
    if (branch) {
      sessions = sessions.filter((s) => s.branch === branch);
    }

    if (sessions.length === 0) {
      console.log(chalk.yellow('No tracked worktree sessions found.'));
      return;
    }

    console.log('');
    console.log(chalk.cyan('Worktree Status'));
    console.log(chalk.cyan('==============='));
    console.log('');

    for (const session of sessions) {
      printSessionStatus(session);
    }
  },
};

function printSessionStatus(session: WorktreeSession): void {
  const typeLabel = session.isGroup
    ? chalk.magenta('[group]')
    : chalk.blue('[repo]');
  console.log(
    `${typeLabel} ${chalk.green(session.target)} ${chalk.white(session.branch)}`,
  );

  // Check if paths exist
  const existingPaths = session.paths.filter((p) => fs.existsSync(p));
  if (existingPaths.length === 0) {
    console.log(chalk.red('  Path(s) no longer exist on disk'));
    console.log(
      chalk.gray(
        `  Created: ${shortDateTime(session.createdAt)}  Last used: ${timeAgo(session.lastAccessedAt)}`,
      ),
    );
    console.log('');
    return;
  }

  // For each existing path, gather git info
  for (const wtPath of existingPaths) {
    const branch = getCurrentBranch(wtPath);
    if (!branch) continue;

    const merged = isBranchMerged(branch, wtPath);
    const changes = getStatus(wtPath);
    const unpushed = getUnpushedCommits(wtPath);

    const changeCount = changes
      ? changes.split('\n').filter((l) => l.trim()).length
      : 0;
    const unpushedCount = unpushed
      ? unpushed.split('\n').filter((l) => l.trim()).length
      : 0;

    const mergedTag = merged
      ? chalk.green(' [merged]')
      : '';

    const parts: string[] = [];
    if (changeCount > 0) {
      parts.push(chalk.yellow(`${changeCount} uncommitted`));
    }
    if (unpushedCount > 0) {
      parts.push(chalk.yellow(`${unpushedCount} unpushed`));
    }

    const statusLine = parts.length > 0 ? parts.join(', ') : chalk.green('clean');

    if (existingPaths.length > 1) {
      console.log(chalk.gray(`  ${wtPath}`));
      console.log(`    ${statusLine}${mergedTag}`);
    } else {
      console.log(`  ${statusLine}${mergedTag}`);
      console.log(chalk.gray(`  ${wtPath}`));
    }
  }

  console.log(
    chalk.gray(
      `  Created: ${shortDateTime(session.createdAt)}  Last used: ${timeAgo(session.lastAccessedAt)}`,
    ),
  );
  console.log('');
}
