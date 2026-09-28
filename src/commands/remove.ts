import chalk from 'chalk';
import { stopSessionPty } from '../core/pty-pool.js';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';
import { teardownWorktree, wouldRefuseRemoval } from '../core/worktree.js';
import { findSession, loadHistory, removeSession } from '../core/history.js';

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
      }),
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

    console.log(chalk.cyan(`Removing worktree: ${targetName}/${branchName}`));
    console.log('');

    // A Claude still running in the worktree (PTY host session) holds it
    // open — Windows refuses the delete — so stop it first. Only when the
    // removal will go through: a refused one must leave the agent running.
    const paths = findSession(loadHistory(), targetName, branchName)?.paths ?? [];
    if (paths.every((p) => !wouldRefuseRemoval(p, force))) {
      await stopSessionPty(targetName, branchName);
    }
    const allRemoved = teardownWorktree(targetName, target.isGroup, branchName, config, force);

    if (allRemoved === true) {
      await removeSession(targetName, branchName);
    } else {
      process.exitCode = 1;
      console.log('');
      console.log(
        chalk.yellow(
          'Some worktrees could not be removed due to uncommitted/unpushed changes.',
        ),
      );
      console.log(
        chalk.yellow(
          `Use 'work remove ${targetName} ${branchName} --force' to force remove.`,
        ),
      );
    }
  },
};
