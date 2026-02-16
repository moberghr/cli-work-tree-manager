import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import { ensureConfig, type WorkConfig } from '../core/config.js';
import { parseWorktreeList, isBranchMerged, getCurrentBranch, getStatus, fetchRemote } from '../core/git.js';
import { removeSingleWorktree } from '../core/worktree.js';
import { removeSession } from '../core/history.js';

interface PrunableEntry {
  type: 'single' | 'group';
  /** repo alias (single) or group name (group) */
  target: string;
  branch: string;
  /** For single: [{ alias, repoPath, worktreePath }]. For group: one per sub-repo. */
  repos: Array<{
    alias: string;
    repoPath: string;
    worktreePath: string;
  }>;
}

export const pruneCommand: CommandModule = {
  command: 'prune',
  describe: 'Remove worktrees for merged branches',
  builder: (yargs) =>
    yargs.option('force', {
      describe: 'Skip interactive picker and remove all merged worktrees',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    const force = argv.force as boolean;

    const config = ensureConfig();
    console.log(chalk.gray('Scanning worktrees for merged branches...\n'));
    const prunable = collectPrunable(config);

    if (prunable.length === 0) {
      console.log(chalk.green('No merged worktrees found. Nothing to prune.'));
      return;
    }

    console.log(
      chalk.cyan(`Found ${prunable.length} merged worktree(s):\n`),
    );

    let selected: PrunableEntry[];

    if (force) {
      selected = prunable;
      for (const entry of selected) {
        const suffix = entry.type === 'group' ? ' [group]' : '';
        console.log(`  ${entry.target}: ${entry.branch}${suffix}`);
      }
      console.log('');
    } else {
      const choices = prunable.map((entry) => {
        const suffix = entry.type === 'group' ? ' [group]' : '';
        return {
          name: `${entry.target}: ${entry.branch}${suffix}`,
          value: entry,
        };
      });

      selected = await checkbox({
        message: 'Select merged worktrees to remove',
        choices,
        pageSize: choices.length,
      });

      if (selected.length === 0) {
        console.log(chalk.yellow('Nothing selected.'));
        return;
      }

      console.log('');
    }

    for (const entry of selected) {
      if (entry.type === 'single') {
        removeSingleEntry(entry);
      } else {
        removeGroupEntry(entry, config);
      }
    }

    console.log('');
    console.log(chalk.green(`Pruned ${selected.length} worktree(s).`));
  },
};

function collectPrunable(config: WorkConfig): PrunableEntry[] {
  const prunable: PrunableEntry[] = [];

  // Fetch all repos upfront so merge checks use up-to-date remote refs
  for (const [alias, repoPath] of Object.entries(config.repos)) {
    if (!fs.existsSync(repoPath)) continue;
    console.log(chalk.gray(`  Fetching ${alias}...`));
    fetchRemote(repoPath);
  }
  console.log('');

  // Track branches already covered by a group so we don't double-list them
  const groupCoveredKeys = new Set<string>();

  // --- Groups ---
  for (const [groupName, aliases] of Object.entries(config.groups)) {
    const groupDir = path.join(config.worktreesRoot, groupName);
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

    for (const branchDir of branchDirs) {
      const branchDirPath = path.join(groupDir, branchDir);
      let branch: string | undefined;
      let allMerged = true;
      const repos: PrunableEntry['repos'] = [];

      for (const alias of aliases) {
        const repoPath = config.repos[alias];
        if (!repoPath) continue;
        const repoName = path.basename(repoPath);
        const subWorktreePath = path.join(branchDirPath, repoName);

        if (!fs.existsSync(subWorktreePath)) {
          // Sub-repo dir missing — could be partially cleaned up
          continue;
        }

        const currentBranch = getCurrentBranch(subWorktreePath);
        if (!currentBranch) {
          allMerged = false;
          console.log(
            chalk.gray(
              `  ${groupName}/${branchDir}/${repoName}: could not determine branch`,
            ),
          );
          continue;
        }

        if (!branch) branch = currentBranch;

        // Check for uncommitted changes first
        const changes = getStatus(subWorktreePath);
        if (changes) {
          console.log(
            `  ${chalk.gray(`${groupName}/${branch} [${alias}]:`)} ${chalk.yellow('has uncommitted changes')}`,
          );
          allMerged = false;
          repos.push({ alias, repoPath, worktreePath: subWorktreePath });
          continue;
        }

        const { merged, into } = isBranchMerged(currentBranch, repoPath);
        const status = merged
          ? chalk.green(`merged into ${into}`)
          : chalk.red('not merged');
        console.log(
          `  ${chalk.gray(`${groupName}/${branch} [${alias}]:`)} ${status}`,
        );
        if (!merged) allMerged = false;

        repos.push({ alias, repoPath, worktreePath: subWorktreePath });
      }

      if (allMerged && repos.length > 0 && branch) {
        prunable.push({
          type: 'group',
          target: groupName,
          branch,
          repos,
        });

        // Mark individual repo+branch pairs as covered by this group
        for (const r of repos) {
          groupCoveredKeys.add(`${r.alias}:${branch}`);
        }
      }
    }
  }

  // --- Single repos ---
  for (const [alias, repoPath] of Object.entries(config.repos)) {
    if (!fs.existsSync(repoPath)) continue;

    const worktrees = parseWorktreeList(repoPath);
    const normalizedRepoPath = path.resolve(repoPath);

    for (const wt of worktrees) {
      // Skip the base worktree (the main repo checkout)
      if (path.resolve(wt.path) === normalizedRepoPath) continue;

      if (!wt.branch) continue;

      // Skip if already covered by a group entry
      if (groupCoveredKeys.has(`${alias}:${wt.branch}`)) continue;

      // Check for uncommitted changes first
      const changes = getStatus(wt.path);
      if (changes) {
        console.log(
          `  ${chalk.gray(`${alias}/${wt.branch}:`)} ${chalk.yellow('has uncommitted changes')}`,
        );
        continue;
      }

      const { merged, into } = isBranchMerged(wt.branch, repoPath);
      const status = merged
        ? chalk.green(`merged into ${into}`)
        : chalk.red('not merged');
      console.log(
        `  ${chalk.gray(`${alias}/${wt.branch}:`)} ${status}`,
      );
      if (merged) {
        prunable.push({
          type: 'single',
          target: alias,
          branch: wt.branch,
          repos: [{ alias, repoPath, worktreePath: wt.path }],
        });
      }
    }
  }

  return prunable;
}

function removeSingleEntry(entry: PrunableEntry): void {
  const { alias, repoPath, worktreePath } = entry.repos[0];
  console.log(chalk.cyan(`Removing ${entry.target}: ${entry.branch}`));

  const removed = removeSingleWorktree(repoPath, worktreePath, entry.branch, true);
  if (removed) {
    removeSession(entry.target, entry.branch);
  }
}

function removeGroupEntry(entry: PrunableEntry, config: WorkConfig): void {
  const workTreeDirName = entry.branch.replace(/\//g, '-');
  const groupWorktreePath = path.join(
    config.worktreesRoot,
    entry.target,
    workTreeDirName,
  );

  console.log(
    chalk.cyan(`Removing group ${entry.target}: ${entry.branch}`),
  );

  let allRemoved = true;

  for (const { alias, repoPath, worktreePath } of entry.repos) {
    const repoName = path.basename(repoPath);
    console.log(chalk.cyan(`  [${alias}] (${repoName}):`));
    const removed = removeSingleWorktree(repoPath, worktreePath, entry.branch, true);
    if (!removed) {
      allRemoved = false;
    }
  }

  if (allRemoved) {
    removeSession(entry.target, entry.branch);
  }

  // Clean up CLAUDE.md in group worktree
  const claudeMdInWorktree = path.join(groupWorktreePath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdInWorktree)) {
    fs.unlinkSync(claudeMdInWorktree);
  }

  // Remove parent dir only if empty
  try {
    if (fs.existsSync(groupWorktreePath)) {
      const contents = fs.readdirSync(groupWorktreePath);
      if (contents.length === 0) {
        fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        console.log(
          chalk.green(
            `  Cleaned up group directory: ${groupWorktreePath}`,
          ),
        );
      }
    }
  } catch {
    // ignore
  }
}
