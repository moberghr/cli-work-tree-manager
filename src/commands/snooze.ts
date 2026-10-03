import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { parseWhen, snoozeLabel } from '../core/rail/snooze.js';
import { clearSnooze, requestSnooze, type SnoozeRequest } from '../core/rail/snooze-store.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work snooze` — the dashboard's Snooze (snooze.ts): out of the Inbox for a while, until a time, or until it changes. */
export const snoozeCommand: CommandModule = {
  command: 'snooze [target] [branch]',
  describe: 'Snooze a session out of the Inbox (default: the session for this folder)',
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('for', { choices: ['2h', 'tomorrow', 'change'] as const, describe: 'Two hours, tomorrow 9:00, or until its status changes (default: 2h)' })
      .option('until', { type: 'string', describe: 'Until a time: 14:00, fri, "fri 14:00", +3h, 2026-10-03 14:00' })
      .option('off', { type: 'boolean', describe: 'Unsnooze it' })
      .conflicts('until', 'for')
      .conflicts('off', ['for', 'until']),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    if (argv.off) {
      console.log(clearSnooze(id) ? chalk.green(`Unsnoozed ${s.target} · ${s.branch}.`) : chalk.gray('It was not snoozed.'));
      return;
    }
    let req: SnoozeRequest;
    if (typeof argv.until === 'string') {
      const at = parseWhen(argv.until);
      if (!at) {
        console.error(chalk.red(`Not a time: ${argv.until} (try 14:00, fri, "fri 14:00", +3h, 2026-10-03 14:00).`));
        process.exitCode = 1;
        return;
      }
      req = { until: at.toISOString() };
    } else req = { for: (argv.for as '2h' | 'tomorrow' | 'change' | undefined) ?? '2h' };
    const r = requestSnooze(id, req);
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Snoozed ${s.target} · ${s.branch} ${snoozeLabel(r.snooze)}.`));
  },
};
