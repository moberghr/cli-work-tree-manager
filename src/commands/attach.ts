import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { findSession, loadHistory } from '../core/history.js';
import { attachSession } from './shared/attach-session.js';
import { loadConfig } from '../core/config.js';
import { findSessionForCwd } from '../core/pending-delivery.js';

export { baseCheckoutSession } from '../core/session-resolve.js';
import { baseCheckoutSession } from '../core/session-resolve.js';

export const attachCommand: CommandModule = {
  command: 'attach [target] [branch]',
  aliases: ['a'],
  describe:
    'Attach this terminal to a session\'s Claude in the PTY host (Ctrl+] detaches; Claude keeps running)',
  builder: (yargs) =>
    yargs
      .positional('target', { type: 'string', describe: 'Repo alias or group (default: session for the current directory)' })
      .positional('branch', { type: 'string', describe: 'Branch (default: the target\'s base checkout)' }),
  handler: async (argv) => {
    const sessions = loadHistory();
    const target = argv.target as string | undefined;
    const branch = argv.branch as string | undefined;
    const session = target
      ? branch
        ? (findSession(sessions, target, branch) ?? null)
        : baseCheckoutSession(sessions, target, loadConfig())
      : findSessionForCwd(process.cwd(), sessions);
    if (!session) {
      console.error(
        chalk.red(
          target
            ? `No session for ${target}${branch ? ` ${branch}` : ' (base checkout)'}. Create it with \`work tree ${target}${branch ? ` ${branch}` : ''}\`.`
            : 'The current directory is not inside a work session. Pass <target> [branch].',
        ),
      );
      process.exit(1);
    }
    // Spawning here too (session not running yet) uses this shell's env.
    process.exitCode = await attachSession(session, { forwardEnv: true });
  },
};
