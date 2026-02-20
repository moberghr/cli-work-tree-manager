import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { select } from '@inquirer/prompts';
import { ensureConfig } from '../core/config.js';
import { loadHistory, getRecentSessions } from '../core/history.js';
import { launchClaude } from '../utils/platform.js';
import { timeAgo } from '../utils/format.js';

export const recentCommand: CommandModule = {
  command: 'recent [count]',
  describe: 'List recent worktree sessions',
  builder: (yargs) =>
    yargs
      .positional('count', {
        describe: 'Number of recent sessions to show',
        type: 'number',
        default: 10,
      })
      .option('resume', {
        describe: 'Interactively pick a session and launch Claude Code',
        type: 'boolean',
        default: false,
      })
      .option('unsafe', {
        describe: 'Launch Claude with --dangerously-skip-permissions (used with --resume)',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const count = argv.count as number;
    const resume = argv.resume as boolean;
    const unsafe = argv.unsafe as boolean;

    ensureConfig();

    const sessions = loadHistory();
    const recent = getRecentSessions(sessions, count);

    if (recent.length === 0) {
      console.log(chalk.yellow('No recent worktree sessions found.'));
      return;
    }

    if (resume) {
      // Filter to sessions that still exist on disk
      const valid = recent.filter((s) =>
        s.paths.some((p) => fs.existsSync(p)),
      );

      if (valid.length === 0) {
        console.log(
          chalk.yellow('No resumable sessions (all paths removed from disk).'),
        );
        return;
      }

      const choice = await select({
        message: 'Select a session to resume:',
        choices: valid.map((s) => {
          const typeTag = s.isGroup ? '[group]' : '[repo]';
          return {
            name: `${typeTag} ${s.target} ${s.branch} (${timeAgo(s.lastAccessedAt)})`,
            value: s,
          };
        }),
      });

      // Find first existing path
      const launchPath = choice.paths.find((p) => fs.existsSync(p));
      if (!launchPath) {
        console.error('Session path no longer exists.');
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan(`Resuming in: ${launchPath}`));
      console.log('Starting Claude Code...');
      launchClaude(launchPath, unsafe);
      return;
    }

    // Just list recent sessions
    console.log('');
    console.log(chalk.cyan('Recent Sessions'));
    console.log(chalk.cyan('==============='));
    console.log('');

    for (const session of recent) {
      const typeLabel = session.isGroup
        ? chalk.magenta('[group]')
        : chalk.blue('[repo]');
      const exists = session.paths.some((p) => fs.existsSync(p));
      const existsTag = exists ? '' : chalk.red(' [removed]');

      console.log(
        `${typeLabel} ${chalk.green(session.target)} ${chalk.white(session.branch)}${existsTag}`,
      );
      console.log(
        chalk.gray(`  Last used: ${timeAgo(session.lastAccessedAt)}`),
      );
    }

    console.log('');
    console.log(
      chalk.gray('Use work2 resume to interactively resume a session.'),
    );
  },
};
