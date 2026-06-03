import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadHistory } from '../core/history.js';
import { broadcastPrompt } from '../core/broadcast.js';

/** Read the whole of stdin synchronously (for `broadcast -`). */
function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export const broadcastCommand: CommandModule = {
  command: 'broadcast <prompt>',
  describe:
    'Queue a prompt to every live session; delivered on each session\'s next turn',
  builder: (yargs) =>
    yargs
      .positional('prompt', {
        describe: 'Prompt to send, or "-" to read from stdin',
        type: 'string',
      })
      .option('target', {
        describe: 'Only sessions for this project/group alias',
        type: 'string',
      })
      .option('branch', {
        describe: 'With --target, only this branch',
        type: 'string',
      })
      .option('all', {
        describe: 'Required to broadcast to every session when no --target',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    let prompt = (argv.prompt as string | undefined) ?? '';
    if (prompt === '-') {
      prompt = readStdin();
    }
    prompt = prompt.trim();
    if (!prompt) {
      console.error(chalk.red('Empty prompt. Usage: work broadcast <prompt>'));
      process.exitCode = 1;
      return;
    }

    const target = argv.target as string | undefined;
    const branch = argv.branch as string | undefined;
    const all = argv.all as boolean;
    if (branch && !target) {
      console.error(chalk.red('--branch requires --target.'));
      process.exitCode = 1;
      return;
    }
    // Guardrail: broadcasting to every session is a wide blast radius, so
    // require an explicit --all (or a narrowing --target) rather than letting
    // a bare `work broadcast "..."` fan out to the whole fleet by accident.
    if (!target && !all) {
      console.error(
        chalk.red(
          'Refusing to broadcast to every session. Pass --all to confirm, or --target <alias> to narrow.',
        ),
      );
      process.exitCode = 1;
      return;
    }

    const queued = await broadcastPrompt(loadHistory(), { target, branch }, prompt);

    if (queued.length === 0) {
      console.log(chalk.yellow('No matching sessions to broadcast to.'));
      return;
    }

    console.log(
      chalk.cyan(
        `Queued prompt to ${queued.length} session${queued.length === 1 ? '' : 's'}:`,
      ),
    );
    for (const t of queued) {
      console.log(
        `  ${chalk.cyan(`[${t.session.target}/${t.session.branch}]`)} ${chalk.gray(t.sessionId)}`,
      );
    }
    console.log('');
    console.log(
      chalk.gray(
        'Delivery is lazy: each session picks this up on its next prompt (UserPromptSubmit hook).',
      ),
    );
  },
};
