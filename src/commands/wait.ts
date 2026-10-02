import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { sessionIdFor } from '../core/session-id.js';
import { parseDuration, waitForTurn } from '../core/session-control.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';
import { cliWaitDeps } from './shared/turn-wait.js';

/** `work wait` — block until a session's agent isn't working: its turn ended, or it asks you something (session-control.ts). */
export const waitCommand: CommandModule = {
  command: 'wait [target] [branch]',
  describe: "Wait until a session's agent finishes its turn or asks you something (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('timeout', { type: 'string', default: '15m', describe: 'Give up after this long (90s, 15m, 1h)' })
      .option('json', { type: 'boolean', default: false, describe: 'Print { state, since, summary } as JSON' }),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const timeoutMs = parseDuration(String(argv.timeout));
    if (timeoutMs === null) {
      console.error(chalk.red(`--timeout: not a duration: ${String(argv.timeout)} (try 90s, 15m, 1h)`));
      process.exitCode = 1;
      return;
    }
    const r = await waitForTurn(sessionIdFor(s), cliWaitDeps, { timeoutMs });
    if (argv.json) process.stdout.write(JSON.stringify(r.ok ? r.status : { timeout: true, ...(r.status ?? {}) }, null, 2) + '\n');
    if (!r.ok) {
      if (!argv.json) console.error(chalk.yellow(`Still ${r.status?.state ?? 'not reporting'} after ${String(argv.timeout)}.`));
      process.exitCode = 2;
      return;
    }
    if (!argv.json) console.log(`${r.status.state === 'needs_input' ? 'Waiting for you' : 'Done'}${r.status.summary ? `: ${r.status.summary}` : ''}`);
  },
};
