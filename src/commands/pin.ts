import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { placeSession } from '../core/rail/rail-store.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work pin` — pin a session to the top of the dashboard's rail (rail-layout.ts), or `--off`. */
export const pinCommand: CommandModule = {
  command: 'pin [target] [branch]',
  describe: "Pin a session to the top of the dashboard's rail (default: the session for this folder)",
  builder: (yargs) => sessionPositionals(yargs).option('off', { type: 'boolean', describe: 'Unpin it' }),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const r = placeSession(sessionIdFor(s), { pinned: !argv.off });
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`${argv.off ? 'Unpinned' : 'Pinned'} ${s.target} · ${s.branch}.`));
  },
};
