import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import type { SessionShownWire } from '../core/api-types.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';

/**
 * `work show <file>` — show a file of this session beside its terminal in the dashboard (a spec you are asked to
 * approve, a plan, a screenshot); `work show --close` takes it away. Meant for an agent to run when it wants you to
 * read something: it reads the file's path only, and changes nothing.
 */
export const showCommand: CommandModule = {
  command: 'show [file]',
  describe: 'Show a file of this session beside its terminal in the dashboard (--close: stop showing it)',
  builder: (yargs) =>
    yargs
      .positional('file', { type: 'string', describe: 'The file to show (Markdown is rendered, an image is drawn, the rest is text)' })
      .option('close', { type: 'boolean', describe: 'Stop showing a file' }),
  handler: async (argv) => {
    const fail = (message: string) => {
      console.error(chalk.red(message));
      process.exitCode = 1;
    };
    const file = typeof argv.file === 'string' && argv.file ? argv.file : undefined;
    if (!file && !argv.close) return fail('Usage: work show <file>   (or: work show --close)');
    const s = findSessionForCwd(process.cwd(), loadHistory());
    if (!s) return fail('This folder is not inside a work session.');
    const url = `/api/sessions/${sessionIdFor(s)}/show`;
    const r = await callWorkWeb<SessionShownWire>(
      'POST',
      url,
      argv.close ? { close: true } : { file: path.resolve(process.cwd(), file!) },
      15_000,
    );
    if (!r.ok) return fail(r.status === 0 ? 'work web is not running: open the app, then run this again.' : r.error);
    console.log(
      r.body.shown
        ? chalk.green(`Showing ${r.body.shown.path} beside the terminal of ${s.target} · ${s.branch}.`)
        : chalk.gray(`${s.target} · ${s.branch} shows no file now.`),
    );
  },
};
