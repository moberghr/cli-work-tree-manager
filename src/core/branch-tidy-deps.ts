import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadHistory } from './history.js';
import { sessionIdFor } from './session-id.js';
import type { BranchTidyDeps } from './branch-tidy.js';

/** The real inputs: the configured repos, and which branches sessions use (per repo alias). */
export function defaultBranchTidyDeps(): BranchTidyDeps {
  return {
    repos: () => Object.entries(loadConfig()?.repos ?? {}).filter(([, p]) => fs.existsSync(p)).map(([alias, path]) => ({ alias, path })),
    sessionBranches: () => {
      const cfg = loadConfig();
      const out = new Map<string, Map<string, { id: string; archived: boolean }>>();
      for (const s of loadHistory()) {
        const aliases = s.isGroup ? (cfg?.groups[s.target] ?? []) : [s.target];
        for (const a of aliases) {
          const m = out.get(a) ?? new Map();
          m.set(s.branch, { id: sessionIdFor(s), archived: !!s.archivedAt });
          out.set(a, m);
        }
      }
      return out;
    },
  };
}
