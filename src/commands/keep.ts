import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { setSessionKeep } from '../core/sessions/history.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work keep` — keep a session once its PR merges (it isn't archived then), or `--off`: the rail menu's item. */
export const keepCommand: CommandModule = {
  command: 'keep [target] [branch]',
  describe: 'Keep a session once its PR merges, instead of archiving it (default: the session for this folder)',
  builder: (yargs) => sessionPositionals(yargs).option('off', { type: 'boolean', describe: 'Archive it once its PR merges, as usual' }),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    if (!(await setSessionKeep(s.target, s.branch, !argv.off))) {
      console.error(chalk.red(`No session ${s.target} · ${s.branch}.`));
      process.exitCode = 1;
      return;
    }
    console.log(
      chalk.green(
        argv.off ? `${s.target} · ${s.branch} is archived once its PR merges.` : `${s.target} · ${s.branch} stays after its PR merges.`,
      ),
    );
  },
};
