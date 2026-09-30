import fs from 'node:fs';
import { loadConfig } from './config.js';
import { listTranscripts } from './context-usage.js';
import { examineWorktree, normPath, type CleanupSession } from './cleanup.js';
import { setSessionArchived, type WorktreeSession } from './history.js';
import { disposePty } from './pty-pool.js';
import { sessionIdFor } from './session-id.js';
import { readStatus } from './session-status.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import { teardownWorktree } from './worktree.js';
import type { ArchiveDeps, ArchivedPr } from './session-archive.js';

export interface ArchiveDepsOptions {
  /** Release other handles on its folders first (the web server's watchers,
   *  a chat's Claude): Windows won't delete a folder something holds open. */
  release?: (sessionId: string) => Promise<void>;
  /** Its PRs, for the summary (the PR watch's cache). */
  prs?: (sessionId: string) => ArchivedPr[];
  run?: CommandRunner;
}

/** The real inputs of archiveSession, the same for the dashboard, the PR watch and the CLI. */
export function defaultArchiveDeps(opts: ArchiveDepsOptions = {}): ArchiveDeps {
  const run = opts.run ?? defaultRunner;
  const config = () => {
    const c = loadConfig();
    if (!c) throw new Error('No config: run `work init` first.');
    return c;
  };
  return {
    stopClaude: async (id) => {
      await disposePty(id);
      await opts.release?.(id);
    },
    removable: async (s) => {
      const cfg = loadConfig();
      if (!cfg) return { ok: false, reason: 'no work config to check it against' };
      const repos = Object.values(cfg.repos).map(normPath);
      // A session on a repo's own checkout (`work tree <repo>` without a
      // branch) points at the repo itself: that folder is never removed.
      if (s.paths.some((p) => repos.includes(normPath(p)))) return { ok: false, reason: "it is the repo's own checkout" };
      if (s.paths.every((p) => !fs.existsSync(p))) return { ok: true, reason: 'already gone' };
      const cs: CleanupSession = {
        id: sessionIdFor(s), target: s.target, branch: s.branch, isGroup: s.isGroup, paths: s.paths,
        archivedAt: null, lastActiveMs: 0, aliases: s.isGroup ? (cfg.groups[s.target] ?? []) : [s.target],
      };
      const c = await examineWorktree(cs, { baseCheckouts: () => Object.values(cfg.repos), run });
      return { ok: c.verdict === 'merged' || c.verdict === 'gone', reason: c.reason };
    },
    removeWorktree: async (s) => {
      if (s.paths.every((p) => !fs.existsSync(p))) return true;
      return teardownWorktree(s.target, s.isGroup, s.branch, config(), true, s.paths);
    },
    setArchived: (s) => setSessionArchived(s.target, s.branch, true),
    transcripts: (s: WorktreeSession) => listTranscripts(s).map((t) => t.file),
    prs: opts.prs,
    lastSummary: (id) => readStatus(id)?.summary ?? null,
  };
}
