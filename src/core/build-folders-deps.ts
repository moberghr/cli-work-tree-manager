import { defaultCleanupDeps } from './cleanup-deps.js';
import { normPath } from './cleanup.js';
import { loadConfig } from './config.js';
import { agentsBySession } from './live-agents.js';
import { liveAgents } from './agents/index.js';
import { loadHistory } from './history.js';
import type { BuildFoldersDeps } from './build-folders-scan.js';

/** The real inputs for the build-folder scan: cleanup's session list (with
 *  "last active"), and which of them have a Claude running now. The same for
 *  the dashboard and `work cleanup --build-folders`. */
export function defaultBuildFoldersDeps(): BuildFoldersDeps {
  const cleanup = defaultCleanupDeps();
  return {
    sessions: async () => {
      const running = agentsBySession(liveAgents(), loadHistory());
      const repos = new Set(Object.values(loadConfig()?.repos ?? {}).map(normPath));
      return (await cleanup.sessions()).map((s) => ({
        id: s.id, target: s.target, branch: s.branch, paths: s.paths, lastActiveMs: s.lastActiveMs, running: running.has(s.id),
        baseCheckout: s.paths.some((p) => repos.has(normPath(p))),
      }));
    },
  };
}
