import fs from 'node:fs';
import { agentFor } from '../core/agents/index.js';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { select } from '@inquirer/prompts';
import { ensureConfig } from '../core/platform/config.js';
import { loadHistory, getRecentSessions, recordLaunch, upsertSession } from '../core/sessions/history.js';
import { effectiveLastAccessedAt } from '../core/sessions/session-activity.js';
import { launchAi } from '../core/platform/launch.js';
import { timeAgo } from '../core/platform/format.js';

export const resumeCommand: CommandModule = {
  command: 'resume',
  describe: 'Resume a recent worktree session',
  builder: (yargs) =>
    yargs.option('unsafe', {
      describe: 'Launch the AI tool with its skip-permissions flag',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    const unsafe = argv.unsafe as boolean;

    const config = ensureConfig();

    const sessions = loadHistory();
    const recent = getRecentSessions(sessions, sessions.length);

    // Filter to sessions that still exist on disk
    const valid = recent.filter((s) => s.paths.some((p) => fs.existsSync(p)));

    if (valid.length === 0) {
      console.log(chalk.yellow('No resumable sessions found.'));
      return;
    }

    const choices = valid.map((s) => {
      const typeTag = s.isGroup ? '[group]' : '[repo]';
      return {
        name: `${typeTag} ${s.target} ${s.branch} (${timeAgo(effectiveLastAccessedAt(s))})`,
        value: s,
      };
    });

    const choice = await select({
      message: 'Select a session to resume:',
      choices,
      pageSize: 15,
    });

    // Find first existing path
    const firstExisting = choice.paths.find((p) => fs.existsSync(p));
    if (!firstExisting) {
      console.error('Session path no longer exists.');
      process.exitCode = 1;
      return;
    }

    // Resume in the directory that actually holds a Claude transcript — the
    // group root, or a sub-repo the user worked in. `--continue` errors out
    // ("No conversation found to continue") when launched somewhere with no
    // transcript, so fall back to a fresh session in that case.
    const { launchPath, hasConversation } = agentFor(config, choice).launch.resumeLaunch(choice);

    await upsertSession(choice.target, choice.isGroup, choice.branch, choice.paths);

    const tool = agentFor(config, choice).launch.tool(config);
    console.log(chalk.cyan(`Resuming in: ${launchPath}`));
    if (!hasConversation) {
      console.log(chalk.yellow(`No prior ${tool.cmd} conversation found for this worktree — starting a fresh session.`));
    }
    console.log(`Starting ${tool.cmd}...`);
    recordLaunch(choice.target, choice.branch, { unsafe: !!unsafe });
    launchAi(launchPath, tool, { unsafe, resume: hasConversation }, choice.port);
  },
};
