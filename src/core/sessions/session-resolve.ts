import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import type { WorktreeSession } from './session-types.js';

/**
 * `work attach <target>` with no branch = the target's base checkout. Those
 * sessions are stored under whatever branch the base repo had checked out
 * (`work tree api` → branch "main"), so match by path, not by an empty
 * branch; if it has been used on several branches, the latest wins.
 */
export function baseCheckoutSession(
  sessions: WorktreeSession[],
  target: string,
  config: Pick<WorkConfig, 'repos'> | null,
): WorktreeSession | null {
  const repoPath = config?.repos[target];
  if (!repoPath) return null;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const matches = sessions
    .filter((s) => s.target === target && !s.isGroup && s.paths[0] && norm(s.paths[0]) === norm(repoPath))
    .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
  return matches[0] ?? null;
}
