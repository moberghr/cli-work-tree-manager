import fs from 'node:fs';
import { loadConfig } from '../platform/config.js';
import { loadHistory } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import type { BranchTidyDeps } from './branch-tidy.js';

/**
 * Which branches sessions use, per repo alias. A repo + branch can belong to
 * several sessions (a single-repo one and a group's): a current one's use
 * wins over an archived one's, whatever order the history lists them in.
 */
export function sessionBranchUse(
  sessions: WorktreeSession[],
  groups: Record<string, string[]>,
): Map<string, Map<string, { id: string; archived: boolean }>> {
  const out = new Map<string, Map<string, { id: string; archived: boolean }>>();
  for (const s of sessions) {
    const aliases = s.isGroup ? (groups[s.target] ?? []) : [s.target];
    for (const a of aliases) {
      const m = out.get(a) ?? new Map<string, { id: string; archived: boolean }>();
      if (m.get(s.branch)?.archived !== false) m.set(s.branch, { id: sessionIdFor(s), archived: !!s.archivedAt });
      out.set(a, m);
    }
  }
  return out;
}

/** The real inputs: the configured repos, and which branches sessions use (per repo alias). */
export function defaultBranchTidyDeps(): BranchTidyDeps {
  return {
    repos: () =>
      Object.entries(loadConfig()?.repos ?? {})
        .filter(([, p]) => fs.existsSync(p))
        .map(([alias, path]) => ({ alias, path })),
    sessionBranches: () => sessionBranchUse(loadHistory(), loadConfig()?.groups ?? {}),
  };
}
