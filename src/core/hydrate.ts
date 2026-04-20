import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from './config.js';
import { parseWorktreeList } from './git.js';
import {
  type WorktreeSession,
  mergeHydratedSessions,
} from './history.js';

interface HydrateResult {
  discovered: number;
  added: number;
  updated: number;
}

/**
 * Scan configured repos for worktrees under worktreesRoot and seed history
 * with any that aren't already tracked. Used for recovery from a wiped
 * history.json and to adopt worktrees created outside work2.
 */
export async function hydrateHistoryFromDisk(
  config: WorkConfig,
): Promise<HydrateResult> {
  const worktreesRoot = path.resolve(config.worktreesRoot);
  const folderNameToAlias = new Map<string, string>();
  for (const [alias, repoPath] of Object.entries(config.repos)) {
    folderNameToAlias.set(path.basename(repoPath), alias);
  }

  // Key: `${target}:${branch}`
  const discovered = new Map<string, WorktreeSession>();

  for (const [alias, repoPath] of Object.entries(config.repos)) {
    if (!fs.existsSync(repoPath)) continue;

    for (const entry of parseWorktreeList(repoPath)) {
      if (!entry.branch) continue;
      if (path.resolve(entry.path) === path.resolve(repoPath)) continue;

      const rel = path.relative(worktreesRoot, entry.path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

      const parts = rel.split(path.sep).filter(Boolean);
      if (parts.length < 2) continue;

      const [first, second] = parts;
      const isGroup = Object.prototype.hasOwnProperty.call(config.groups, first);

      if (isGroup) {
        const groupName = first;
        const key = `${groupName}:${entry.branch}`;
        const existing = discovered.get(key);
        if (existing) {
          if (!existing.paths.includes(entry.path)) {
            existing.paths.push(entry.path);
            existing.paths.sort();
          }
        } else {
          const { createdAt, lastAccessedAt } = inferTimestamps(entry.path);
          discovered.set(key, {
            target: groupName,
            isGroup: true,
            branch: entry.branch,
            paths: [entry.path],
            createdAt,
            lastAccessedAt,
          });
        }
        // silence unused warning for `second` — branch-dir segment isn't needed
        void second;
      } else {
        // Single-repo worktree. `first` must be the repo's folder name.
        const aliasFromFolder = folderNameToAlias.get(first);
        if (aliasFromFolder !== alias) continue;

        const key = `${alias}:${entry.branch}`;
        if (discovered.has(key)) continue;
        const { createdAt, lastAccessedAt } = inferTimestamps(entry.path);
        discovered.set(key, {
          target: alias,
          isGroup: false,
          branch: entry.branch,
          paths: [entry.path],
          createdAt,
          lastAccessedAt,
        });
      }
    }
  }

  const sessions = [...discovered.values()];
  const { added, updated } = await mergeHydratedSessions(sessions);
  return { discovered: sessions.length, added, updated };
}

function inferTimestamps(p: string): {
  createdAt: string;
  lastAccessedAt: string;
} {
  try {
    const stat = fs.statSync(p);
    const created = stat.birthtime.getTime() > 0 ? stat.birthtime : stat.mtime;
    return {
      createdAt: created.toISOString(),
      lastAccessedAt: stat.mtime.toISOString(),
    };
  } catch {
    const now = new Date().toISOString();
    return { createdAt: now, lastAccessedAt: now };
  }
}
