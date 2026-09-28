import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { findSession, loadHistory, type WorktreeSession } from '../core/history.js';
import { attachSession } from './shared/attach-session.js';
import { loadConfig, type WorkConfig } from '../core/config.js';
import { findSessionForCwd } from '../core/pending-delivery.js';

/**
 * `work attach <target>` with no branch = the target's base checkout. Those
 * sessions are stored under whatever branch the base repo had checked out
 * (`work tree api` → branch "main"), so match by path, not by an empty
 * branch; if it has been used on several branches, the latest wins.
 */
export function baseCheckoutSession(
  sessions: WorktreeSession[],
  target: string,
  config: Pick<WorkConfig, 'repos'> | null,
): WorktreeSession | null {
  const repoPath = config?.repos[target];
  if (!repoPath) return null;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const matches = sessions
    .filter((s) => s.target === target && !s.isGroup && s.paths[0] && norm(s.paths[0]) === norm(repoPath))
    .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
  return matches[0] ?? null;
}

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
