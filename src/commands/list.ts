import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { parseWorktreeList, getCurrentBranch } from '../core/git.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/resolve.js';

export const listCommand: CommandModule = {
  command: 'list [target]',
  describe: 'List worktrees',
  builder: (yargs) =>
    yargs.positional('target', {
      describe: 'Project alias or group name (omit to list all)',
      type: 'string',
    }),
  handler: (argv) => {
    const targetName = argv.target as string | undefined;

    const config = ensureConfig();
    const worktreesRoot = config.worktreesRoot;

    console.log('');
    console.log(chalk.cyan('Worktrees'));
    console.log(chalk.cyan('========='));
    console.log('');

    let showRepos: string[] = [];
    let showGroups: string[] = [];

    if (targetName) {
      const target = resolveProjectTarget(targetName, config);
      if (!target) {
        const allNames = getAllTargetNames(config);
        console.error(`Project or group not found: ${targetName}`);
        console.log(chalk.yellow(`Available: ${allNames.join(', ')}`));
        process.exitCode = 1;
        return;
      }
      if (target.isGroup) {
        showGroups = [targetName];
      } else {
        showRepos = [targetName];
      }
    } else {
      showRepos = Object.keys(config.repos);
      showGroups = Object.keys(config.groups);
    }

    let foundAny = false;

    // Show per-repo worktrees
    for (const proj of showRepos) {
      const repoPath = config.repos[proj];

      if (!fs.existsSync(repoPath)) {
        console.log(
          chalk.red(
            `${proj} -> Repository path not found: ${repoPath}`,
          ),
        );
        continue;
      }

      const worktreeList = parseWorktreeList(repoPath).filter(
        (wt) => wt.path !== repoPath,
      );

      if (worktreeList.length > 0) {
        foundAny = true;
        const plural = worktreeList.length !== 1 ? 's' : '';
        console.log(
          chalk.green(
            `${proj} (${worktreeList.length} worktree${plural}):`,
          ),
        );

        for (const wt of worktreeList) {
          const branchDisplay = wt.branch || `detached at ${wt.head}`;
          console.log(`  ${branchDisplay}`);
          console.log(chalk.gray(`    ${wt.path}`));
        }
        console.log('');
      }
    }

    // Show group worktrees
    for (const groupName of showGroups) {
      const groupDir = path.join(worktreesRoot, groupName);
      if (!fs.existsSync(groupDir)) continue;

      let branchDirs: string[];
      try {
        branchDirs = fs
          .readdirSync(groupDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }

      if (branchDirs.length === 0) continue;

      foundAny = true;
      const plural = branchDirs.length !== 1 ? 's' : '';
      console.log(
        chalk.magenta(
          `${groupName} [group] (${branchDirs.length} worktree${plural}):`,
        ),
      );

      for (const bdName of branchDirs) {
        const bdPath = path.join(groupDir, bdName);

        // Try to determine the actual branch name from a sub-worktree
        let repoSubDirs: string[];
        try {
          repoSubDirs = fs
            .readdirSync(bdPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== '.git')
            .map((d) => d.name);
        } catch {
          repoSubDirs = [];
        }

        let actualBranch: string | null = null;
        for (const rdName of repoSubDirs) {
          const rdPath = path.join(bdPath, rdName);
          const branch = getCurrentBranch(rdPath);
          if (branch) {
            actualBranch = branch;
            break;
          }
        }

        const displayBranch = actualBranch || bdName;
        console.log(`  ${displayBranch}`);
        console.log(chalk.gray(`    ${bdPath}`));
        if (repoSubDirs.length > 0) {
          console.log(
            chalk.gray(`    Repos: ${repoSubDirs.join(', ')}`),
          );
        }
      }
      console.log('');
    }

    if (!foundAny) {
      if (targetName) {
        console.log(
          chalk.yellow(`No worktrees found for: ${targetName}`),
        );
      } else {
        console.log(
          chalk.yellow(
            'No worktrees found for any project or group',
          ),
        );
      }
      console.log('');
    }
  },
};
