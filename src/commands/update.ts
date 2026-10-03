import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { updateSession } from '../core/stacks/session-update.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work update` — the dashboard's Update from main / Update from <parent> /
 * Move onto main (session-update.ts): whichever the session needs.
 */
export const updateCommand: CommandModule = {
  command: 'update [target] [branch]',
  describe: "Bring a session's branch up to date: from main, from the session it is stacked on, or onto main once that one merged",
  builder: (yargs) => sessionPositionals(yargs),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const r = await updateSession(s);
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    const what = r.how === 'onto-main' ? `onto main (${r.base} merged)` : r.how === 'parent' ? `from ${r.base}` : 'from main';
    console.log(chalk.cyan(`Updating ${s.target} · ${s.branch} ${what}…`));
    for (const x of r.results) {
      if (!x.ok) console.log(chalk.red(`  ${x.repo}: ${x.reason}`));
      else if (x.how === 'nothing') console.log(chalk.gray(`  ${x.repo}: already up to date`));
      else
        console.log(
          chalk.green(
            `  ${x.repo}: ${x.how === 'rebase' ? 'rebased on' : 'merged'} ${x.base} (${x.commits} commit${x.commits === 1 ? '' : 's'})`,
          ),
        );
    }
    if (r.results.some((x) => !x.ok)) process.exitCode = 1;
  },
};
