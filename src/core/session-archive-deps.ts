import fs from 'node:fs';
import path from 'node:path';
import { checkedOutBranch } from './git-head.js';
import { loadConfig } from './config.js';
import { listTranscripts } from './context-usage.js';
import { examineWorktree, normPath, type CleanupSession } from './cleanup.js';
import { loadHistory, setSessionArchived, type WorktreeSession } from './history.js';
import { disposePty } from './pty-pool.js';
import { sessionIdFor } from './session-id.js';
import { readStatus } from './session-status.js';
import { shownState } from './turn-activity.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import { teardownWorktree } from './worktree.js';
import type { ArchiveDeps, ArchivedPr } from './session-archive.js';
import { readPendingForSession } from './pending-delivery.js';
import { listReplies } from './pr-replies.js';
import { stopDev } from './dev-server.js';
import { buildFoldersOf, clearBuildFolders } from './build-folders.js';
import { clearCheckpoints } from './checkpoint.js';
import { scopeHashForPaths } from './scope-manager.js';
import { runClaude } from './checkpoint-summary.js';
import { summarizeArchive } from './archive-summary.js';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What archiving now would leave unfinished, in words (empty: nothing):
 * replies Claude drafted for you to post, notes its Claude hasn't been
 * given yet, a Claude mid-turn or waiting for your answer.
 */
export function archiveWaiting(id: string): string[] {
  const out: string[] = [];
  const drafts = listReplies(id).filter((r) => r.status === 'draft').length;
  if (drafts) out.push(`${plural(drafts, 'reply', 'replies')} to post on review threads`);
  const pending = readPendingForSession(id).length;
  if (pending) out.push(`${plural(pending, 'note', 'notes')} not yet delivered to its Claude`);
  // As the dashboard shows it (a Claude that died mid-turn isn't "working" forever).
  const session = loadHistory().find((s) => sessionIdFor(s) === id);
  const st = session ? shownState(session) : readStatus(id)?.state;
  if (st === 'working') out.push('its Claude is working');
  if (st === 'needs_input') out.push('its Claude is waiting for your answer');
  return out;
}

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
    waiting: archiveWaiting,
    stopDev: (id) => void stopDev(id),
    heads: (s) => {
      const out: Record<string, string> = {};
      for (const [alias, repo] of repoPaths(s, loadConfig())) {
        const wt = worktreeOf(s, repo);
        const branch = wt ? checkedOutBranch(wt) : null;
        if (branch && branch !== s.branch) out[alias] = branch;
      }
      return out;
    },
    tips: async (s, heads) => {
      const cfg = loadConfig();
      const out: Record<string, string> = {};
      for (const [alias, repo] of repoPaths(s, cfg)) {
        const r = await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${heads[alias] ?? s.branch}`], repo);
        if (r.code === 0 && r.stdout.trim()) out[alias] = r.stdout.trim();
      }
      return out;
    },
    clearBuildFolders: async (s) => {
      let folders = 0;
      let bytes = 0;
      for (const p of s.paths) {
        if (!fs.existsSync(p)) continue;
        const sized = await buildFoldersOf(p, run);
        const r = await clearBuildFolders(p, run);
        folders += r.removed.length;
        bytes += sized.filter((f) => r.removed.includes(f.path)).reduce((n, f) => n + f.bytes, 0);
      }
      return { folders, bytes };
    },
    tidy: async (s, heads) => {
      const cfg = loadConfig();
      const repos = repoPaths(s, cfg);
      // Its per-turn checkpoints: refs in the repos, and their manifest.
      try {
        clearCheckpoints(scopeHashForPaths(s.paths), repos.map(([, r]) => r));
      } catch {
        /* best effort: orphaned refs only cost a little space */
      }
      // A local branch already in the main branch goes (its tip is recorded,
      // and reachable from the main branch, so Restore can recreate it). A
      // squash-merged one stays: its commits are reachable from nothing else.
      // Both the session's branch and the one checked out, when Claude switched.
      const deleted: string[] = [];
      for (const [alias, repo] of repos) {
        const base = (await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], repo)).stdout.trim();
        if (!base || base === 'origin/HEAD') continue;
        const merged = (await run('git', ['-C', repo, 'branch', '--merged', base, '--format=%(refname:short)'], repo)).stdout.split('\n').map((l) => l.trim());
        const inUse = (await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], repo)).stdout;
        const head = heads[alias] ?? s.branch;
        for (const branch of new Set([s.branch, head])) {
          if (!merged.includes(branch) || inUse.includes(`branch refs/heads/${branch}\n`)) continue;
          // Reported only for the checked-out one: that is what Restore recreates.
          if ((await run('git', ['-C', repo, 'branch', '-D', branch], repo)).code === 0 && branch === head) deleted.push(alias);
        }
      }
      return deleted;
    },
    summarize: (rec) => summarizeArchive(rec, (prompt) => runClaude(prompt, 60_000)),
  };
}

/** The session's worktree of a repo: its only path, or (a group) the one named after the repo's folder. */
function worktreeOf(s: WorktreeSession, repo: string): string | null {
  if (!s.isGroup) return s.paths[0] ?? null;
  const name = path.basename(repo).toLowerCase();
  return s.paths.find((p) => path.basename(p).toLowerCase() === name) ?? null;
}

/** The session's repos as [alias, base checkout path] (a group: each member). */
function repoPaths(s: WorktreeSession, cfg: ReturnType<typeof loadConfig>): Array<[string, string]> {
  if (!cfg) return [];
  const aliases = s.isGroup ? (cfg.groups[s.target] ?? []) : [s.target];
  return aliases.filter((a) => cfg.repos[a] && fs.existsSync(cfg.repos[a])).map((a) => [a, cfg.repos[a]]);
}
