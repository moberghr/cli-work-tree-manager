import chalk from 'chalk';
import type { Argv } from 'yargs';
import { loadConfig } from '../../core/config.js';
import { findSession, loadHistory, type WorktreeSession } from '../../core/history.js';
import { findSessionForCwd } from '../../core/pending-delivery.js';
import { baseCheckoutSession } from '../attach.js';

/**
 * Which session a command acts on, as `work attach` reads it: `<target>
 * <branch>`; `<target>` alone, its base checkout; nothing, the session for
 * this folder.
 */
export function sessionPositionals<T>(yargs: Argv<T>) {
  return yargs
    .positional('target', { type: 'string', describe: 'Repo alias or group (default: the session for this folder)' })
    .positional('branch', { type: 'string', describe: "Branch (default: the target's base checkout)" });
}

/** The session, or null with the reason printed (exit code 1). */
export function sessionFromArgs(argv: Record<string, unknown>): WorktreeSession | null {
  const sessions = loadHistory();
  const target = typeof argv.target === 'string' ? argv.target : undefined;
  const branch = typeof argv.branch === 'string' ? argv.branch : undefined;
  const s = target
    ? branch
      ? (findSession(sessions, target, branch) ?? null)
      : baseCheckoutSession(sessions, target, loadConfig())
    : findSessionForCwd(process.cwd(), sessions);
  if (!s) {
    console.error(
      chalk.red(
        target
          ? `No session for ${target}${branch ? ` ${branch}` : ' (base checkout)'}.`
          : 'This folder is not inside a work session: pass <target> [branch].',
      ),
    );
    process.exitCode = 1;
  }
  return s;
}
