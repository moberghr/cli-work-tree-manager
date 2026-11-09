import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/platform/config.js';
import { parseWorktreeList, getCurrentBranch } from '../core/git/git.js';
import { resolveProjectTarget, getAllTargetNames } from '../core/worktree/resolve.js';
import { loadHistory, type WorktreeSession } from '../core/sessions/history.js';

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
        console.log(chalk.red(`${proj} -> Repository path not found: ${repoPath}`));
        continue;
      }

      const worktreeList = parseWorktreeList(repoPath).filter((wt) => wt.path !== repoPath);

      if (worktreeList.length > 0) {
        foundAny = true;
        const plural = worktreeList.length !== 1 ? 's' : '';
        console.log(chalk.green(`${proj} (${worktreeList.length} worktree${plural}):`));

        for (const wt of worktreeList) {
          const branchDisplay = wt.branch || `detached at ${wt.head}`;
          console.log(`  ${branchDisplay}`);
          console.log(chalk.gray(`    ${wt.path}`));
        }
        console.log('');
      }
    }

    // Show group worktrees
    const sessions = showGroups.length ? loadHistory() : [];
    for (const groupName of showGroups) {
      const groupDir = path.join(worktreesRoot, groupName);
      // Its sessions in a flat session folder (`sessionFolders`), which isn't under the group's folder.
      const flat = flatGroupSessions(groupName, groupDir, sessions).filter((f) => fs.existsSync(f.folder));

      let branchDirs: string[] = [];
      try {
        if (fs.existsSync(groupDir))
          branchDirs = fs
            .readdirSync(groupDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
      } catch {
        branchDirs = [];
      }

      if (branchDirs.length === 0 && flat.length === 0) continue;

      foundAny = true;
      const count = branchDirs.length + flat.length;
      const plural = count !== 1 ? 's' : '';
      console.log(chalk.magenta(`${groupName} [group] (${count} worktree${plural}):`));
      for (const f of flat) {
        console.log(`  ${f.branch}`);
        console.log(chalk.gray(`    ${f.folder}`));
        if (f.repos.length) console.log(chalk.gray(`    Repos: ${f.repos.join(', ')}`));
      }

      const repoAliases = config.groups[groupName] ?? [];

      for (const bdName of branchDirs) {
        const bdPath = path.join(groupDir, bdName);

        // Determine the actual branch name from the first sub-worktree
        let actualBranch: string | null = null;
        for (const alias of repoAliases) {
          const repoPath = config.repos[alias];
          if (!repoPath) continue;
          const rdPath = path.join(bdPath, path.basename(repoPath));
          if (fs.existsSync(rdPath)) {
            const branch = getCurrentBranch(rdPath);
            if (branch) {
              actualBranch = branch;
              break;
            }
          }
        }

        const displayBranch = actualBranch || bdName;
        console.log(`  ${displayBranch}`);
        console.log(chalk.gray(`    ${bdPath}`));
        if (repoAliases.length > 0) {
          console.log(chalk.gray(`    Repos: ${repoAliases.join(', ')}`));
        }
      }
      console.log('');
    }

    if (!foundAny) {
      if (targetName) {
        console.log(chalk.yellow(`No worktrees found for: ${targetName}`));
      } else {
        console.log(chalk.yellow('No worktrees found for any project or group'));
      }
      console.log('');
    }
  },
};

/**
 * A group's live sessions whose folder isn't under `<root>/<group>/` (a flat
 * session folder, `sessionFolders`): their branch, folder and own repos. Pure.
 */
export function flatGroupSessions(
  groupName: string,
  groupDir: string,
  sessions: WorktreeSession[],
): Array<{ branch: string; folder: string; repos: string[] }> {
  const under = (p: string) =>
    path
      .resolve(p)
      .toLowerCase()
      .startsWith(path.resolve(groupDir).toLowerCase() + path.sep);
  return sessions
    .filter((s) => s.target === groupName && s.isGroup && !s.archivedAt && s.paths[0] && !under(s.paths[0]))
    .map((s) => ({ branch: s.branch, folder: path.dirname(s.paths[0]), repos: s.repos ?? [] }));
}
