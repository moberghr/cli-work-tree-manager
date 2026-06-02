import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { type WorkConfig } from './config.js';
import {
  parseWorktreeList,
  isBranchMerged,
  getCurrentBranch,
  getStatus,
  fetchRemote,
} from './git.js';
import { removeSingleWorktree } from './worktree.js';
import { removeSession } from './history.js';

export interface PrunableEntry {
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

interface ScanEntry {
  target: string;
  branch: string;
  merged: boolean;
  into: string | null;
  hasChanges: boolean;
  /** Sub-label for group repos, e.g. "[straumur]" */
  subLabel?: string;
}

export interface CollectOptions {
  /**
   * When true, fetch each configured repo before scanning so merge checks use
   * up-to-date remote refs. Defaults to true (matches `work prune`). Callers
   * that already fetched (e.g. `work sync`, which fetches in parallel) pass
   * false to avoid redundant serial fetches.
   */
  fetch?: boolean;
  /** When false, suppress the per-target scan-result table. Defaults to true. */
  print?: boolean;
}

export function collectPrunable(
  config: WorkConfig,
  options: CollectOptions = {},
): PrunableEntry[] {
  const { fetch = true, print = true } = options;
  const prunable: PrunableEntry[] = [];
  const scanResults: ScanEntry[] = [];

  // Fetch all repos upfront so merge checks use up-to-date remote refs
  if (fetch) {
    for (const [alias, repoPath] of Object.entries(config.repos)) {
      if (!fs.existsSync(repoPath)) continue;
      console.log(chalk.gray(`  Fetching ${alias}...`));
      fetchRemote(repoPath);
    }
    console.log('');
  }

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
          continue;
        }

        const currentBranch = getCurrentBranch(subWorktreePath);
        if (!currentBranch) {
          allMerged = false;
          continue;
        }

        if (!branch) branch = currentBranch;

        const { merged, into } = isBranchMerged(currentBranch, repoPath);
        const changes = getStatus(subWorktreePath);

        scanResults.push({
          target: groupName,
          branch,
          merged,
          into,
          hasChanges: !!changes,
          subLabel: alias,
        });

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
      if (path.resolve(wt.path) === normalizedRepoPath) continue;
      if (!wt.branch) continue;
      if (groupCoveredKeys.has(`${alias}:${wt.branch}`)) continue;

      const { merged, into } = isBranchMerged(wt.branch, repoPath);
      const changes = getStatus(wt.path);

      scanResults.push({
        target: alias,
        branch: wt.branch,
        merged,
        into,
        hasChanges: !!changes,
      });

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

  // Print scan results grouped by target, merged first
  if (print) {
    printScanResults(scanResults);
  }

  return prunable;
}

export function printScanResults(results: ScanEntry[]): void {
  // Group by target
  const byTarget = new Map<string, ScanEntry[]>();
  for (const r of results) {
    const entries = byTarget.get(r.target) ?? [];
    entries.push(r);
    byTarget.set(r.target, entries);
  }

  for (const [target, entries] of byTarget) {
    // Sort: not merged first, then merged
    entries.sort((a, b) => (a.merged === b.merged ? 0 : a.merged ? 1 : -1));

    console.log(chalk.cyan(`${target}:`));
    for (const e of entries) {
      const parts: string[] = [];
      parts.push(e.merged ? chalk.green(`merged into ${e.into}`) : chalk.red('not merged'));
      if (e.hasChanges) parts.push(chalk.yellow('uncommitted changes'));

      const label = e.subLabel
        ? `${e.branch} [${e.subLabel}]`
        : e.branch;
      console.log(`  ${chalk.gray(`${label}:`)} ${parts.join(', ')}`);
    }
    console.log('');
  }
}

export async function removeSingleEntry(entry: PrunableEntry): Promise<void> {
  const { repoPath, worktreePath } = entry.repos[0];
  console.log(chalk.cyan(`Removing ${entry.target}: ${entry.branch}`));

  const removed = removeSingleWorktree(repoPath, worktreePath, entry.branch, true);
  if (removed) {
    await removeSession(entry.target, entry.branch);
  }
}

export async function removeGroupEntry(
  entry: PrunableEntry,
  config: WorkConfig,
): Promise<void> {
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
    await removeSession(entry.target, entry.branch);
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
