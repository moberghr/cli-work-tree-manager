import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from './config.js';
import { getConfigDir } from './config.js';
import { json, purgeSessionRows, tx, withDb, type Db } from './db.js';
import { sessionIdFor } from './session-id.js';
import { effectiveLastAccessedAt } from './claude-activity.js';
import { allocateFreePort } from './port-allocator.js';
import { removeSessionFiles, stopSessionDevServer } from './session-store.js';

export type { WorktreeSession } from './session-types.js';
import type { WorktreeSession } from './session-types.js';

/**
 * Worktree sessions, in the `sessions` table of ~/.work/state.db (db.ts):
 * one row per target:branch, the record as JSON. Writes are transactions,
 * so concurrent `work tree` / `remove` / work web can't clobber each other
 * (the old history.json needed a file lock for that — and once lost 60+
 * sessions without it).
 */

/** The pre-SQLite history file. Only the one-time import (db-import.ts)
 *  reads it now. */
export function getHistoryPath(): string {
  return path.join(getConfigDir(), 'history.json');
}

function valid(s: unknown): s is WorktreeSession {
  const x = s as WorktreeSession | null;
  return !!x && typeof x.target === 'string' && typeof x.branch === 'string' && Array.isArray(x.paths);
}

function rows(d: Db): WorktreeSession[] {
  return (d.prepare('SELECT data FROM sessions ORDER BY rowid').all() as Array<{ data: string }>)
    .map((r) => json.parse(r.data))
    .filter(valid);
}

function getRow(d: Db, target: string, branch: string): WorktreeSession | undefined {
  const r = d.prepare('SELECT data FROM sessions WHERE id = ?').get(sessionIdFor({ target, branch })) as
    | { data: string }
    | undefined;
  const s = r ? json.parse(r.data) : null;
  return valid(s) ? s : undefined;
}

function putRow(d: Db, s: WorktreeSession): void {
  d.prepare(
    'INSERT INTO sessions (id, target, branch, data) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  ).run(sessionIdFor(s), s.target, s.branch, JSON.stringify(s));
}

/** One session by its id (the `sessions` primary key). */
export function findSessionById(id: string): WorktreeSession | null {
  return withDb((d) => {
    const r = d.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    const s = r ? json.parse(r.data) : null;
    return valid(s) ? s : null;
  });
}

/** Every session, in the order they were first recorded. */
export function loadHistory(): WorktreeSession[] {
  return withDb(rows);
}

/** Replace the whole history (bulk rewrites, tests). */
export function saveHistory(sessions: WorktreeSession[]): void {
  tx((d) => {
    d.prepare('DELETE FROM sessions').run();
    const seen = new Set<string>();
    for (const s of sessions) {
      if (!valid(s)) continue;
      const id = sessionIdFor(s);
      if (seen.has(id)) continue; // first entry wins, as findSession does
      seen.add(id);
      putRow(d, s);
    }
  });
}

function sessionKey(target: string, branch: string): string {
  return `${target}:${branch}`;
}

export function findSession(
  sessions: WorktreeSession[],
  target: string,
  branch: string,
): WorktreeSession | undefined {
  return sessions.find(
    (s) => s.target === target && s.branch === branch,
  );
}

export async function upsertSession(
  target: string,
  isGroup: boolean,
  branch: string,
  paths: string[],
  jiraKey?: string,
  baseBranch?: string,
  port?: number,
): Promise<void> {
  tx((d) => {
    const existing = getRow(d, target, branch);
    const now = new Date().toISOString();

    if (existing) {
      existing.paths = paths;
      existing.lastAccessedAt = now;
      delete existing.archivedAt; // coming back to it un-archives it
      if (jiraKey) existing.jiraKey = jiraKey;
      if (baseBranch && !existing.baseBranch) existing.baseBranch = baseBranch;
      if (port !== undefined) existing.port = port;
      putRow(d, existing);
    } else {
      const session: WorktreeSession = {
        target,
        isGroup,
        branch,
        paths,
        createdAt: now,
        lastAccessedAt: now,
      };
      if (jiraKey) session.jiraKey = jiraKey;
      if (baseBranch) session.baseBranch = baseBranch;
      if (port !== undefined) session.port = port;
      putRow(d, session);
    }
  });
}

/**
 * Allocate a stable dev-server port AND persist the session, without two
 * concurrent `work tree` runs picking the same port.
 *
 * Allocation probes ports (async) and a transaction can't span an await,
 * so it is optimistic: pick a port against a snapshot, then in one write
 * transaction re-check that no other live session took it meanwhile — and
 * if one did, pick again.
 *
 * Port allocation is best-effort: if it fails (range exhausted, etc.) the
 * session is still persisted, just without a port, and `port` comes back
 * undefined. An already-allocated port on an existing session is preserved
 * (idempotent re-runs keep their port).
 *
 * The allocation seed is `target:branch` (unique per worktree) so two repos
 * that share a branch name don't collide on the same deterministic base offset.
 */
export async function upsertSessionWithPort(
  target: string,
  isGroup: boolean,
  branch: string,
  paths: string[],
  config: Pick<WorkConfig, 'portRange'>,
  jiraKey?: string,
  baseBranch?: string,
  baseBranches?: Record<string, string>,
): Promise<{ port?: number }> {
  const hasPerRepo = baseBranches && Object.keys(baseBranches).length > 0;
  const id = sessionIdFor({ target, branch });

  const write = (d: Db, port: number | undefined): number | undefined => {
    const existing = getRow(d, target, branch);
    const now = new Date().toISOString();
    if (existing) {
      existing.paths = paths;
      existing.lastAccessedAt = now;
      delete existing.archivedAt; // coming back to it un-archives it
      if (jiraKey) existing.jiraKey = jiraKey;
      if (baseBranch && !existing.baseBranch) existing.baseBranch = baseBranch;
      if (hasPerRepo && !existing.baseBranches) existing.baseBranches = baseBranches;
      if (existing.port === undefined && port !== undefined) existing.port = port;
      putRow(d, existing);
      return existing.port;
    }
    const session: WorktreeSession = { target, isGroup, branch, paths, createdAt: now, lastAccessedAt: now };
    if (jiraKey) session.jiraKey = jiraKey;
    if (baseBranch) session.baseBranch = baseBranch;
    if (hasPerRepo) session.baseBranches = baseBranches;
    if (port !== undefined) session.port = port;
    putRow(d, session);
    return port;
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const sessions = loadHistory();
    const existing = findSession(sessions, target, branch);
    let port = existing?.port;
    if (port === undefined) {
      try {
        port = await allocateFreePort(sessionKey(target, branch), config, sessions);
      } catch {
        port = undefined;
      }
    }
    const done = tx((d) => {
      // Another `work tree` may have taken this port since the snapshot:
      // only a port no other live session holds may be kept.
      if (port !== undefined && getRow(d, target, branch)?.port === undefined) {
        const taken = rows(d).some(
          (s) => sessionIdFor(s) !== id && s.port === port && s.paths.some((p) => fs.existsSync(p)),
        );
        if (taken) return null;
      }
      return { port: write(d, port) };
    });
    if (done) return done;
  }
  // Could not get an uncontested port: record the session without one.
  return tx((d) => ({ port: write(d, undefined) }));
}

/** Record how the AI tool was just launched for this session. */
export function recordLaunch(target: string, branch: string, opts: { unsafe: boolean }): void {
  tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return;
    if (opts.unsafe) s.launchedUnsafe = true;
    else delete s.launchedUnsafe;
    putRow(d, s);
  });
}

/** Archive / un-archive a session. Returns false when it doesn't exist. */
export async function setSessionArchived(
  target: string,
  branch: string,
  archived: boolean,
): Promise<boolean> {
  return tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return false;
    if (archived) s.archivedAt = new Date().toISOString();
    else delete s.archivedAt;
    putRow(d, s);
    return true;
  });
}

export async function removeSession(target: string, branch: string): Promise<void> {
  const id = sessionIdFor({ target, branch });
  if (!withDb((d) => getRow(d, target, branch))) return; // nothing to remove: touch nothing
  // The session's other state (status, comments, saved PTY entry, …) goes
  // with it — in the SAME transaction, so a crash can't leave state behind
  // for a re-created session to inherit (see session-store.ts).
  stopSessionDevServer(id);
  const removed = tx((d) => {
    const gone = d.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
    if (gone) purgeSessionRows(d, id);
    return gone;
  });
  if (removed) removeSessionFiles(id);
}

export function getSessionsForTarget(
  sessions: WorktreeSession[],
  target: string,
): WorktreeSession[] {
  return sessions.filter((s) => s.target === target);
}

export function getRecentSessions(
  sessions: WorktreeSession[],
  count: number,
): WorktreeSession[] {
  return [...sessions]
    .sort(
      (a, b) =>
        new Date(effectiveLastAccessedAt(b)).getTime() -
        new Date(effectiveLastAccessedAt(a)).getTime(),
    )
    .slice(0, count);
}

export function pruneStaleEntries(sessions: WorktreeSession[]): {
  kept: WorktreeSession[];
  pruned: number;
} {
  const kept: WorktreeSession[] = [];
  let pruned = 0;

  for (const session of sessions) {
    const anyPathExists = session.paths.some((p) => fs.existsSync(p));
    if (anyPathExists) {
      kept.push(session);
    } else {
      pruned++;
    }
  }

  return { kept, pruned };
}

/** Persisted prune for `status --prune` callers. */
export async function prunePersistedStaleEntries(): Promise<{ pruned: number }> {
  const stale = pruneStaleEntries(loadHistory()).kept;
  const keep = new Set(stale.map((s) => sessionIdFor(s)));
  for (const s of loadHistory()) if (!keep.has(sessionIdFor(s))) stopSessionDevServer(sessionIdFor(s));
  const gone = tx((d) => {
    const drop = rows(d).filter((s) => !keep.has(sessionIdFor(s)));
    const del = d.prepare('DELETE FROM sessions WHERE id = ?');
    for (const s of drop) {
      del.run(sessionIdFor(s));
      purgeSessionRows(d, sessionIdFor(s));
    }
    return drop;
  });
  for (const s of gone) removeSessionFiles(sessionIdFor(s));
  return { pruned: gone.length };
}

/**
 * Merge hydrated sessions into history without clobbering existing entries.
 * For each incoming session: if a matching target+branch exists, refresh its
 * paths (if different) but keep original timestamps. Otherwise insert.
 */
export async function mergeHydratedSessions(
  incoming: WorktreeSession[],
): Promise<{ added: number; updated: number }> {
  return tx((d) => {
    let added = 0;
    let updated = 0;

    for (const inc of incoming) {
      const existing = getRow(d, inc.target, inc.branch);
      if (existing) {
        const sortedA = [...existing.paths].sort();
        const sortedB = [...inc.paths].sort();
        const same =
          sortedA.length === sortedB.length &&
          sortedA.every((p, i) => p === sortedB[i]);
        if (!same) {
          existing.paths = inc.paths;
          putRow(d, existing);
          updated++;
        }
      } else {
        putRow(d, inc);
        added++;
      }
    }
    return { added, updated };
  });
}
