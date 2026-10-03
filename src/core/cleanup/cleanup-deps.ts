import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type WorkConfig } from '../platform/config.js';
import { loadHistory, removeSession } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { readSessionActivity } from '../sessions/session-activity.js';
import { readStatus } from '../status/session-status.js';
import { disposePty } from '../pty/pty-pool.js';
import { teardownWorktree } from '../worktree/worktree.js';
import { archiveSession } from '../archive/session-archive.js';
import { defaultArchiveDeps } from '../archive/session-archive-deps.js';
import { fetchRemoteAsync } from '../git/git.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import { normPath, type CleanupDeps, type CleanupSession } from './cleanup.js';
import type { CleanupAction } from '../api-types.js';

/**
 * The real inputs for cleanup (cleanup.ts): work's history, the worktrees
 * git has that history doesn't, the configured repos, and the removal that
 * Delete in the dashboard uses. The same for the web view and the CLI.
 */

/** Newest sign of life: the hook status, Claude's last write, the entry. */
function lastActiveMs(lastAccessedAt: string, id: string, activity: number | null): number {
  const status = readStatus(id);
  return Math.max(Date.parse(lastAccessedAt) || 0, activity ?? 0, status ? Date.parse(status.updatedAt) || 0 : 0);
}

function parsePorcelain(out: string): Array<{ path: string; branch: string }> {
  const list: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of out.split('\n')) {
    const w = line.match(/^worktree (.+)$/);
    if (w) {
      if (cur.path) list.push({ path: cur.path, branch: cur.branch ?? '' });
      cur = { path: w[1].trim() };
    }
    const b = line.match(/^branch refs\/heads\/(.+)$/);
    if (b) cur.branch = b[1].trim();
  }
  if (cur.path) list.push({ path: cur.path, branch: cur.branch ?? '' });
  return list;
}

/**
 * Worktrees git knows that work's history doesn't: a group laid out under
 * `<worktreesRoot>/<group>/<branch>/<repo>`, and any other linked worktree of
 * a configured repo. They have no activity data (lastActiveMs 0): the
 * uncommitted-changes check is what protects them.
 */
export async function untrackedWorktrees(
  config: WorkConfig,
  trackedPaths: Set<string>,
  run: CommandRunner = defaultRunner,
): Promise<CleanupSession[]> {
  const out: CleanupSession[] = [];
  const covered = new Set(trackedPaths);

  for (const [group, aliases] of Object.entries(config.groups)) {
    const groupDir = path.join(config.worktreesRoot, group);
    let branchDirs: string[];
    try {
      branchDirs = fs
        .readdirSync(groupDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const dir of branchDirs) {
      const members = aliases
        .map((alias) => ({ alias, repo: config.repos[alias] }))
        .filter((m) => !!m.repo)
        .map((m) => ({ ...m, wt: path.join(groupDir, dir, path.basename(m.repo)) }))
        .filter((m) => fs.existsSync(m.wt));
      if (members.length === 0 || members.some((m) => covered.has(normPath(m.wt)))) continue;
      const branch = (await run('git', ['branch', '--show-current'], members[0].wt)).stdout.trim();
      if (!branch) continue;
      for (const m of members) covered.add(normPath(m.wt));
      out.push({
        id: `untracked:${normPath(path.join(groupDir, dir))}`,
        target: group,
        branch,
        isGroup: true,
        paths: members.map((m) => m.wt),
        archivedAt: null,
        lastActiveMs: 0,
        aliases: members.map((m) => m.alias),
        untracked: true,
      });
    }
  }

  for (const [alias, repo] of Object.entries(config.repos)) {
    if (!fs.existsSync(repo)) continue;
    const list = await run('git', ['worktree', 'list', '--porcelain'], repo);
    if (list.code !== 0) continue;
    // The first entry is always the main worktree (the repo itself).
    for (const wt of parsePorcelain(list.stdout).slice(1)) {
      if (!wt.branch || covered.has(normPath(wt.path))) continue;
      covered.add(normPath(wt.path));
      out.push({
        id: `untracked:${normPath(wt.path)}`,
        target: alias,
        branch: wt.branch,
        isGroup: false,
        paths: [path.resolve(wt.path)],
        archivedAt: null,
        lastActiveMs: 0,
        aliases: [alias],
        untracked: true,
      });
    }
  }
  return out;
}

export interface CleanupDepsOptions {
  /** Release other handles on a worktree before it is removed (the web
   *  server closes its file watcher; a watched folder can't be deleted on
   *  Windows). The session's PTY is always stopped. */
  release?: (sessionId: string) => Promise<void>;
  run?: CommandRunner;
}

export function defaultCleanupDeps(opts: CleanupDepsOptions = {}): CleanupDeps {
  const run = opts.run ?? defaultRunner;
  const config = () => {
    const c = loadConfig();
    if (!c) throw new Error('No config: run `work init` first.');
    return c;
  };
  return {
    sessions: async () => {
      const cfg = config();
      const tracked: CleanupSession[] = loadHistory().map((s) => {
        const id = sessionIdFor(s);
        return {
          id,
          target: s.target,
          branch: s.branch,
          isGroup: s.isGroup,
          paths: s.paths,
          archivedAt: s.archivedAt ?? null,
          lastActiveMs: lastActiveMs(s.lastAccessedAt, id, readSessionActivity(s).lastActivity),
          aliases: s.isGroup ? (cfg.groups[s.target] ?? []) : [s.target],
        };
      });
      const trackedPaths = new Set(tracked.flatMap((s) => s.paths.map(normPath)));
      return [...tracked, ...(await untrackedWorktrees(cfg, trackedPaths, run))];
    },
    baseCheckouts: () => Object.values(loadConfig()?.repos ?? {}),
    fetchRepos: () =>
      Object.entries(loadConfig()?.repos ?? {})
        .filter(([, p]) => fs.existsSync(p))
        .map(([alias, p]) => ({ alias, path: p })),
    fetch: (repoPath) => fetchRemoteAsync(repoPath),
    run,
    act: async (s: CleanupSession, action: CleanupAction) => {
      if (action === 'archive') {
        // Keeps the conversation; the worktree stays when it has work in it.
        const session = loadHistory().find((h) => sessionIdFor(h) === s.id);
        if (!session) throw new Error('Not archived: work does not track it.');
        const out = await archiveSession(session, defaultArchiveDeps({ release: opts.release, run }));
        if (!out.ok) throw new Error(out.message);
        return;
      }
      if (action === 'delete') {
        // Stop its Claude and release our handles first: a live PTY's cwd
        // (or a watched folder) blocks the delete on Windows. Force skips
        // only the "ahead of upstream" refusal: the caller just re-checked
        // there is nothing uncommitted (or was told to discard it) and
        // nothing the main branch lacks; the branch itself is kept.
        if (!s.untracked) {
          await disposePty(s.id);
          await opts.release?.(s.id);
        }
        // By its folder (what the scan examined), not by branch name: the
        // branch checked out there may since have changed.
        if (!teardownWorktree(s.target, s.isGroup, s.branch, config(), true, s.paths))
          throw new Error('git refused to remove the worktree.');
      }
      if (!s.untracked) await removeSession(s.target, s.branch); // delete and forget
    },
  };
}
