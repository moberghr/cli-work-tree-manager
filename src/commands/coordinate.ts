import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { adoptChild, coordinatorSince, MAX_CHILDREN, releaseChild, setCoordinator } from '../core/sessions/session-children.js';
import { findSession, loadHistory } from '../core/sessions/history.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work coordinate` — let a session start, message and finish sessions of its own without asking each time
 * (`work child …`, session-children.ts). It is the grant, so it is never pre-allowed: Claude running it asks you.
 * `--off` takes it back; no flag says whether it stands.
 */
export const coordinateCommand: CommandModule = {
  command: 'coordinate [target] [branch]',
  describe: 'Let a session start and drive sessions of its own without asking each time (default: the session for this folder)',
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('on', { type: 'boolean', describe: 'Grant it' })
      .option('off', { type: 'boolean', describe: 'Take it back' })
      .option('adopt', {
        type: 'array',
        string: true,
        describe: 'Also coordinate a session you already have: --adopt <target> <branch> (grants it too)',
      })
      .option('release', { type: 'array', string: true, describe: 'Stop coordinating one: --release <target> <branch>' })
      .check((a) => !(a.on && a.off) || 'Give --on or --off, not both')
      .check(
        (a) =>
          [a.adopt, a.release].every((v) => v === undefined || (Array.isArray(v) && v.length === 2)) ||
          'Name the session as <target> <branch>',
      ),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const name = `${s.target} · ${s.branch}`;
    const other = (v: unknown) => {
      const [t, b] = v as [string, string];
      const o = findSession(loadHistory(), t, b);
      if (!o) {
        console.error(chalk.red(`No session ${t} ${b}.`));
        process.exitCode = 1;
      }
      return o ?? null;
    };
    if (argv.release) {
      const o = other(argv.release);
      if (!o) return;
      const done = releaseChild(id, sessionIdFor(o));
      console.log(done ? `${name} no longer coordinates ${o.target} · ${o.branch}.` : chalk.gray(`${name} did not coordinate it.`));
      return;
    }
    if (argv.adopt) {
      const o = other(argv.adopt);
      if (!o) return;
      if (o.archivedAt) {
        console.error(chalk.red(`${o.target} · ${o.branch} is archived: restore it first.`));
        process.exitCode = 1;
        return;
      }
      const r = adoptChild(id, sessionIdFor(o));
      if (!r.ok) {
        console.error(chalk.red(`${o.target} · ${o.branch}: ${r.error}`));
        process.exitCode = 1;
        return;
      }
      setCoordinator(id, true);
      console.log(
        chalk.green(
          `${name} now coordinates ${o.target} · ${o.branch}: \`work child send\` reaches it without asking (typed in when idle, started when asleep), and it reports back with \`work report\`. Its permission prompts still come to you.`,
        ),
      );
      return;
    }
    if (argv.on) {
      setCoordinator(id, true);
      console.log(
        chalk.green(
          `${name} may now start up to ${MAX_CHILDREN} sessions of its own, message them and archive them (\`work child …\`) without asking. Their permission prompts still come to you. \`work coordinate --off\` takes it back.`,
        ),
      );
      return;
    }
    if (argv.off) {
      setCoordinator(id, false);
      console.log(chalk.green(`${name} asks you again before driving other sessions.`));
      return;
    }
    const since = coordinatorSince(id);
    console.log(
      since ? `${name} coordinates sessions of its own (since ${since}).` : chalk.gray(`${name} does not coordinate other sessions.`),
    );
  },
};
