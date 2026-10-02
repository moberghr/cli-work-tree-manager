import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { askCatchUp, catchUpFacts } from '../core/catch-up-routes.js';
import { catchUp } from '../core/catch-up.js';
import { sessionIdFor } from '../core/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work catchup` — the dashboard's Catch me up (catch-up.ts): a few sentences on where a session stands. */
export const catchupCommand: CommandModule = {
  command: 'catchup [target] [branch]',
  describe: 'A few sentences on where a session stands: done, left, anything waiting on you (default: the session for this folder)',
  builder: (yargs) => sessionPositionals(yargs),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    console.error(chalk.gray(`Reading the last week of ${s.target} · ${s.branch}…`));
    const r = await catchUp(s, askCatchUp, catchUpFacts(sessionIdFor(s)));
    if (!r) {
      console.error(chalk.yellow('Nothing to go on: no conversation in the last week, or no answer from Claude.'));
      process.exitCode = 1;
      return;
    }
    console.log(r.text);
  },
};
