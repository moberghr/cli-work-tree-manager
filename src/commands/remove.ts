import fs from 'node:fs';
import chalk from 'chalk';
import { archiveWaiting } from '../core/archive/session-archive-deps.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { stopSessionPty } from '../core/pty/pty-pool.js';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/platform/config.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/worktree/resolve.js';
import { teardownWorktree, wouldRefuseRemoval } from '../core/worktree/worktree.js';
import { findSession, loadHistory, removeSession } from '../core/sessions/history.js';
import { WORKTREE_REMOVED } from '../core/worktree/remove-child.js';

export const removeCommand: CommandModule = {
  command: 'remove <target> <branch>',
  describe: 'Remove a worktree',
  builder: (yargs) =>
    yargs
      .showHelpOnFail(true)
      .positional('target', {
        describe: 'Project alias or group name',
        type: 'string',
        demandOption: true,
      })
      .positional('branch', {
        describe: 'Branch name (e.g., feature/login)',
        type: 'string',
        demandOption: true,
      })
      .option('force', {
        describe: 'Force remove even with uncommitted/unpushed changes',
        type: 'boolean',
        default: false,
      })
      // work web's Archive: only the folders, the session kept, its agent already stopped (remove-child.ts).
      .option('worktree-only', { type: 'boolean', default: false, hidden: true }),
  handler: async (argv) => {
    const targetName = argv.target as string;
    const branchName = argv.branch as string;
    const force = argv.force as boolean;

    const config = ensureConfig();

    const target = resolveProjectTarget(targetName, config);
    if (!target) {
      const allNames = getAllTargetNames(config);
      console.error(`Project or group not found: ${targetName}`);
      console.log(chalk.yellow(`Available: ${allNames.join(', ')}`));
      process.exitCode = 1;
      return;
    }

    // work web's Archive, in a child so its git doesn't hold the server up: the folders only. The archive has
    // already checked nothing is lost, saved what's uncommitted and stopped the agent; the session stays.
    if (argv['worktree-only']) {
      const s = findSession(loadHistory(), targetName, branchName);
      const gone = !s || s.paths.every((p) => !fs.existsSync(p));
      const removed = gone || teardownWorktree(targetName, s.isGroup, branchName, config, true, s.paths);
      console.log(`${WORKTREE_REMOVED}${removed === true}`);
      return;
    }

    // What removing would cut off — its Claude mid-turn or waiting on you,
    // replies to post, notes not yet delivered — refuses it unless --force,
    // as the dashboard's delete does.
    const existing = findSession(loadHistory(), targetName, branchName);
    if (existing && !force) {
      const waiting = archiveWaiting(sessionIdFor(existing));
      if (waiting.length) {
        console.error(chalk.red(`Not removed: ${waiting.join('; ')}.`));
        console.log(chalk.yellow(`Use 'work remove ${targetName} ${branchName} --force' to remove it anyway.`));
        process.exitCode = 1;
        return;
      }
    }

    console.log(chalk.cyan(`Removing worktree: ${targetName}/${branchName}`));
    console.log('');

    // A Claude still running in the worktree (PTY host session) holds it
    // open — Windows refuses the delete — so stop it first. Only when the
    // removal will go through: a refused one must leave the agent running.
    const paths = findSession(loadHistory(), targetName, branchName)?.paths ?? [];
    if (paths.every((p) => !wouldRefuseRemoval(p, force))) {
      await stopSessionPty(targetName, branchName);
    }
    // The session's folder, not the branch name: the branch checked out in it
    // may have been switched since.
    const allRemoved = teardownWorktree(targetName, target.isGroup, branchName, config, force, paths.length ? paths : undefined);

    if (allRemoved === true) {
      await removeSession(targetName, branchName);
    } else {
      process.exitCode = 1;
      console.log('');
      console.log(chalk.yellow('Some worktrees could not be removed due to uncommitted/unpushed changes.'));
      console.log(chalk.yellow(`Use 'work remove ${targetName} ${branchName} --force' to force remove.`));
    }
  },
};
