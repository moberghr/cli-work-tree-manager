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
  type MergeConfidence,
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
  /**
   * True if any (sub-)repo in this entry has uncommitted changes. Used by
   * callers to decide whether removal needs the explicit --force escape hatch.
   */
  hasChanges: boolean;
  /**
   * Merge confidence for the whole entry. 'merged' is a high-confidence true
   * merge; 'squash-merged' means at least one (sub-)repo only matched via the
   * lower-confidence squash heuristic. Unattended callers should require an
   * explicit opt-in before pruning 'squash-merged' entries.
   */
  confidence: MergeConfidence;
}

interface ScanEntry {
  target: string;
  branch: string;
  merged: boolean;
  into: string | null;
  hasChanges: boolean;
  /**
   * Merge confidence for this row. 'squash-merged' rows only matched the
   * lower-confidence squash heuristic and are gated out of the prunable list
   * by default — the table labels them distinctly so it never claims a row is
   * a plain 'merged' when prune/sync will actually skip it.
   */
  confidence: MergeConfidence | null;
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
  /**
   * When true, include entries whose only positive signal is the
   * lower-confidence squash-merge heuristic. Defaults to false so unattended
   * callers (e.g. `work sync`) require true-merge confidence and only opt into
   * squash matches explicitly.
   */
  includeSquash?: boolean;
  /**
   * Aliases to skip entirely (e.g. repos whose fetch failed, so their remote
   * refs may be stale and merge checks unreliable). Worktrees in these repos
   * are never reported as prunable.
   */
  skipAliases?: Set<string>;
}

export function collectPrunable(
  config: WorkConfig,
  options: CollectOptions = {},
): PrunableEntry[] {
  const { fetch = true, print = true, includeSquash = false } = options;
  const skipAliases = options.skipAliases ?? new Set<string>();
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
      let groupHasChanges = false;
      // Whole-group confidence is the weakest across sub-repos: if any sub-repo
      // only matched via the squash heuristic, the group is squash-confidence.
      let groupConfidence: MergeConfidence = 'merged';
      let skipped = false;
      const repos: PrunableEntry['repos'] = [];

      for (const alias of aliases) {
        const repoPath = config.repos[alias];
        if (!repoPath) continue;
        // Skip groups touching a repo we couldn't fetch — stale refs make the
        // merge check unreliable, so we must not prune on them.
        if (skipAliases.has(alias)) {
          skipped = true;
          continue;
        }
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

        const { merged, into, confidence } = isBranchMerged(currentBranch, repoPath);
        const changes = getStatus(subWorktreePath);
        if (changes) groupHasChanges = true;

        scanResults.push({
          target: groupName,
          branch,
          merged,
          into,
          hasChanges: !!changes,
          confidence,
          subLabel: alias,
        });

        if (!merged) {
          allMerged = false;
        } else if (confidence === 'squash-merged') {
          groupConfidence = 'squash-merged';
        }
        repos.push({ alias, repoPath, worktreePath: subWorktreePath });
      }

      const squashGated = groupConfidence === 'squash-merged' && !includeSquash;
      if (allMerged && !skipped && !squashGated && repos.length > 0 && branch) {
        prunable.push({
          type: 'group',
          target: groupName,
          branch,
          repos,
          hasChanges: groupHasChanges,
          confidence: groupConfidence,
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
    // Skip repos we couldn't fetch — stale refs make merge checks unreliable.
    if (skipAliases.has(alias)) continue;

    // `git worktree list --porcelain` always emits the main worktree
    // (the original `.git` repo) first, with linked worktrees after.
    // Drop the head of the list rather than comparing paths — the path
    // comparison is fragile on Windows where `repoPath` may carry a
    // legacy 8.3 short-name segment (e.g. `C:\Users\DOMAGO~1\...`)
    // while git always emits the canonical long-name form. `path.resolve`
    // doesn't bridge that gap, and `realpathSync` on Windows doesn't
    // expand 8.3 names either.
    const worktrees = parseWorktreeList(repoPath).slice(1);

    for (const wt of worktrees) {
      if (!wt.branch) continue;
      if (groupCoveredKeys.has(`${alias}:${wt.branch}`)) continue;

      const { merged, into, confidence } = isBranchMerged(wt.branch, repoPath);
      const changes = getStatus(wt.path);

      scanResults.push({
        target: alias,
        branch: wt.branch,
        merged,
        into,
        hasChanges: !!changes,
        confidence,
      });

      const squashGated = confidence === 'squash-merged' && !includeSquash;
      if (merged && confidence && !squashGated) {
        prunable.push({
          type: 'single',
          target: alias,
          branch: wt.branch,
          repos: [{ alias, repoPath, worktreePath: wt.path }],
          hasChanges: !!changes,
          confidence,
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
      if (!e.merged) {
        parts.push(chalk.red('not merged'));
      } else if (e.confidence === 'squash-merged') {
        // Distinct label: squash matches are skipped by default (sync needs
        // --include-squash), so don't show them as a plain 'merged'.
        parts.push(chalk.yellow(`squash-merged into ${e.into} (skipped unless --include-squash)`));
      } else {
        parts.push(chalk.green(`merged into ${e.into}`));
      }
      if (e.hasChanges) parts.push(chalk.yellow('uncommitted changes'));

      const label = e.subLabel
        ? `${e.branch} [${e.subLabel}]`
        : e.branch;
      console.log(`  ${chalk.gray(`${label}:`)} ${parts.join(', ')}`);
    }
    console.log('');
  }
}

/**
 * Remove a single-repo prunable entry. Returns true only if the worktree was
 * actually removed (so callers can tally non-throwing failures). When `force`
 * is false, removeSingleWorktree refuses worktrees with uncommitted changes or
 * unpushed commits and returns false.
 */
export async function removeSingleEntry(
  entry: PrunableEntry,
  force = true,
): Promise<boolean> {
  const { repoPath, worktreePath } = entry.repos[0];
  console.log(chalk.cyan(`Removing ${entry.target}: ${entry.branch}`));

  const removed = removeSingleWorktree(repoPath, worktreePath, entry.branch, force);
  if (removed) {
    await removeSession(entry.target, entry.branch);
  }
  return removed;
}

/**
 * Remove a group prunable entry (one worktree per sub-repo). Returns true only
 * if every sub-repo worktree was removed. When `force` is false, dirty/unpushed
 * sub-repos are refused and the entry is reported as a failure.
 */
export async function removeGroupEntry(
  entry: PrunableEntry,
  config: WorkConfig,
  force = true,
): Promise<boolean> {
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
    const removed = removeSingleWorktree(repoPath, worktreePath, entry.branch, force);
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

  return allRemoved;
}
