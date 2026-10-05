import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { blockRefFrom } from '../core/rail/session-blocks.js';
import { addBlocker, blockKey, readBlock, removeBlocker } from '../core/rail/session-blocks.js';
import { findSession, loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work block` — "Blocked by" (session-blocks.ts) from a terminal: the
 * session waits on another session (`--on <alias> --on-branch <branch>`) or
 * a pull request (`--pr <url>`); `--off` stops waiting; no option lists it.
 */
export const blockCommand: CommandModule = {
  command: 'block [target] [branch]',
  describe: 'Mark a session as waiting on another session or a PR (out of the Inbox until that is done)',
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('on', { type: 'string', describe: 'The repo or group of the session it waits on' })
      .option('on-branch', { type: 'string', describe: 'The branch of the session it waits on' })
      .option('pr', { type: 'string', describe: 'A pull request URL it waits on' })
      .option('off', { type: 'boolean', describe: 'Stop waiting (on everything, or with --on/--pr on that one)' }),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const name = `${s.target} · ${s.branch}`;
    let ref = null;
    if (typeof argv.on === 'string') {
      const other = typeof argv['on-branch'] === 'string' ? findSession(loadHistory(), argv.on, argv['on-branch']) : null;
      if (!other) {
        console.error(chalk.red(`No live session ${argv.on} ${argv['on-branch'] ?? '(give --on-branch)'}.`));
        process.exitCode = 1;
        return;
      }
      ref = blockRefFrom({ kind: 'session', id: sessionIdFor(other) });
    } else if (typeof argv.pr === 'string') {
      ref = blockRefFrom({ kind: 'pr', url: argv.pr });
      if (!ref) {
        console.error(chalk.red(`Not a GitHub pull request URL: ${argv.pr}`));
        process.exitCode = 1;
        return;
      }
    }
    if (argv.off) {
      removeBlocker(id, ref ? blockKey(ref) : undefined);
      console.log(chalk.green(ref ? `${name} no longer waits on ${ref.label}.` : `${name} no longer waits on anything.`));
      return;
    }
    if (!ref) {
      const b = readBlock(id);
      if (!b) console.log(chalk.gray(`${name} waits on nothing.`));
      else
        for (const x of b.by)
          console.log(`${x.label}${x.kind === 'pr' ? `  ${chalk.gray(x.url)}${x.state ? ` (${x.state.toLowerCase()})` : ''}` : ''}`);
      return;
    }
    const r = addBlocker(id, ref);
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`${name} waits on ${ref.label}: out of the Inbox until it is done.`));
  },
};
