import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { select } from '@inquirer/prompts';
import { ensureConfig } from '../core/config.js';
import { loadHistory, getRecentSessions, upsertSession } from '../core/history.js';
import { launchClaude } from '../utils/platform.js';
import { timeAgo } from '../utils/format.js';

export const resumeCommand: CommandModule = {
  command: 'resume',
  describe: 'Resume a recent worktree session',
  builder: (yargs) =>
    yargs.option('unsafe', {
      describe: 'Launch Claude with --dangerously-skip-permissions',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    const unsafe = argv.unsafe as boolean;

    ensureConfig();

    const sessions = loadHistory();
    const recent = getRecentSessions(sessions, 10);

    // Filter to sessions that still exist on disk
    const valid = recent.filter((s) =>
      s.paths.some((p) => fs.existsSync(p)),
    );

    if (valid.length === 0) {
      console.log(
        chalk.yellow('No resumable sessions found.'),
      );
      return;
    }

    const choices = valid.map((s) => {
      const typeTag = s.isGroup ? '[group]' : '[repo]';
      return {
        name: `${typeTag} ${s.target} ${s.branch} (${timeAgo(s.lastAccessedAt)})`,
        value: s,
      };
    });

    const choice = await select({
      message: 'Select a session to resume:',
      choices,
      pageSize: choices.length,
    });

    // Find first existing path
    const firstExisting = choice.paths.find((p) => fs.existsSync(p));
    if (!firstExisting) {
      console.error('Session path no longer exists.');
      process.exitCode = 1;
      return;
    }

    // For groups, launch in the parent directory (group root), not a single repo subfolder
    const launchPath = choice.isGroup ? path.dirname(firstExisting) : firstExisting;

    upsertSession(choice.target, choice.isGroup, choice.branch, choice.paths);

    console.log(chalk.cyan(`Resuming in: ${launchPath}`));
    console.log('Starting Claude Code...');
    launchClaude(launchPath, unsafe);
  },
};
