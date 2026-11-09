import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { parseWorktreeList } from '../git/git.js';
import { type WorktreeSession, mergeHydratedSessions } from './history.js';
import { flatFolderOwner } from '../worktree/session-folder.js';

interface HydrateResult {
  discovered: number;
  added: number;
  updated: number;
}

/**
 * Scan configured repos for worktrees under worktreesRoot and seed history
 * with any that aren't already tracked. Used for recovery from a wiped
 * history.json and to adopt worktrees created outside work.
 */
export async function hydrateHistoryFromDisk(config: WorkConfig): Promise<HydrateResult> {
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
      // A session folder of a repo (config `sessionFolders`): `<root>/<alias>/<branch>/<repo-folder>`
      // — exactly that deep, `<alias>` a repo's alias (or its folder's name), the last part this repo's folder.
      const folderOwner = isGroup ? undefined : folderSessionOwner(parts, repoPath, config, folderNameToAlias);
      // A flat session folder (`sessionFolders`): `<root>/<branch>-<id6>/<repo-folder>`, its project
      // found by the id (the one whose session of this branch has this folder's name).
      const flatOwner =
        !isGroup && !folderOwner && parts.length === 2 && second.toLowerCase() === path.basename(repoPath).toLowerCase()
          ? flatFolderOwner(first, entry.branch, config)
          : undefined;

      if (isGroup || folderOwner || flatOwner) {
        const groupName = flatOwner ?? folderOwner ?? first;
        const key = `${groupName}:${entry.branch}`;
        const existing = discovered.get(key);
        if (existing) {
          if (!existing.paths.includes(entry.path)) {
            // Sorted by path (as before), each folder keeping its repo beside it.
            const repos = existing.repos ?? [];
            const pairs = [...existing.paths.map((p, i): [string, string] => [p, repos[i]]), [entry.path, alias] as [string, string]];
            pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            existing.paths = pairs.map(([p]) => p);
            existing.repos = pairs.map(([, a]) => a);
          }
        } else {
          const { createdAt, lastAccessedAt } = inferTimestamps(entry.path);
          discovered.set(key, {
            target: groupName,
            isGroup: true,
            branch: entry.branch,
            paths: [entry.path],
            repos: [alias],
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
          repos: [alias],
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

/** The repo alias a session folder's worktree belongs to (its target), or undefined when the path isn't one. */
function folderSessionOwner(
  parts: string[],
  repoPath: string,
  config: WorkConfig,
  folderNameToAlias: Map<string, string>,
): string | undefined {
  if (parts.length !== 3) return undefined;
  const [first, , repoFolder] = parts;
  if (repoFolder.toLowerCase() !== path.basename(repoPath).toLowerCase()) return undefined;
  if (Object.prototype.hasOwnProperty.call(config.repos, first)) return first;
  return folderNameToAlias.get(first);
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
