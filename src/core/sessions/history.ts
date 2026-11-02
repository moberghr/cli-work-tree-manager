import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { getConfigDir, loadConfig } from '../platform/config.js';
import { agentFor, agentToRecord } from '../agents/index.js';

/**
 * What a new session records about its agent: the configured one when work has an adapter for it (agents/), and — for
 * an agent with accounts (its adapter's `accounts` part) — the account it runs on: the one asked for, else that agent's
 * default, so a later change of the default never moves it. An agent without accounts records none.
 */
const recordAgent = (account?: string): { agent?: string; account?: string } => {
  const config = loadConfig();
  const agent = agentToRecord(config);
  const accounts = agentFor(config).accounts;
  return { ...(agent ? { agent } : {}), ...(accounts ? { account: account || accounts.defaultName() } : {}) };
};
import { json, purgeSessionRows, tx, withDb, type Db } from '../platform/db.js';
import { sessionIdFor } from './session-id.js';
import { effectiveLastAccessedAt } from './session-activity.js';
import { allocateFreePort } from '../worktree/port-allocator.js';
import { removeSessionFiles, stopSessionDevServer, clearSessionCheckpoints } from './session-store.js';

export type { WorktreeSession } from './session-types.js';
import type { SessionInstructions, WorktreeSession } from './session-types.js';
import { recordedRepos, sessionRepos } from './session-repos.js';

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
  const r = d.prepare('SELECT data FROM sessions WHERE id = ?').get(sessionIdFor({ target, branch })) as { data: string } | undefined;
  const s = r ? json.parse(r.data) : null;
  return valid(s) ? s : undefined;
}

function putRow(d: Db, s: WorktreeSession): void {
  d.prepare(
    'INSERT INTO sessions (id, target, branch, data) VALUES (?, ?, ?, ?) ' + 'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  ).run(sessionIdFor(s), s.target, s.branch, JSON.stringify(s));
}

/**
 * A repo added to a session (add-repo.ts): its worktree appended to the
 * session's paths, its alias to its repos (a row from before gets its list
 * recorded first, as derived), and its base — in one transaction over the row
 * as it is now. `before` is the paths it had, read in that transaction (the
 * scope its turns move from). Already there: unchanged. Null when the session
 * is gone. Throws, writing nothing, when a folder of a row from before can't
 * be matched to a repo of its group (it would be recorded under a made-up alias).
 *
 * The base: one `baseBranch` stands for every repo only when every repo has it
 * (as a group's is recorded). An added repo made from it keeps that; one made
 * from another, or checked out on a branch it had (no base known), gets its own
 * entry or none, and the others keep theirs — each in `baseBranches`.
 */
export function appendSessionRepo(
  id: string,
  alias: string,
  worktree: string,
  from: string | undefined,
  config: WorkConfig,
  /** Its folder's file gets the repo's import (an agent that can import): recorded on the
   *  session when it has no mode yet — a group's copied summary keeps it, the block after it. */
  imports = false,
): { before: string[]; session: WorktreeSession } | null {
  return tx((d) => {
    const r = d.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    const s = r ? json.parse(r.data) : null;
    if (!valid(s)) return null;
    const own = sessionRepos(s, config);
    const unknown = own.filter((x) => x.guessed).map((x) => path.basename(x.path));
    if (unknown.length) throw new Error(`no repo of its group is in ${unknown.join(', ')}, so its repos can't be recorded`);
    const repos = own.map((x) => x.alias);
    const before = [...s.paths];
    if (repos.includes(alias)) return { before, session: s };
    if (s.baseBranch && from !== s.baseBranch) {
      const perRepo = { ...(s.baseBranches ?? {}) };
      for (const p of s.paths) perRepo[p] ??= s.baseBranch;
      s.baseBranches = perRepo;
      delete s.baseBranch;
    }
    s.paths = [...s.paths, worktree];
    s.repos = [...repos, alias];
    if (imports && !s.instructions) s.instructions = config.groups?.[s.target] ? 'summary+imports' : 'imports';
    if (from) s.baseBranches = { ...(s.baseBranches ?? {}), [worktree]: from };
    putRow(d, s);
    return { before, session: s };
  });
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

export function findSession(sessions: WorktreeSession[], target: string, branch: string): WorktreeSession | undefined {
  return sessions.find((s) => s.target === target && s.branch === branch);
}

/**
 * A session's folders as a writer gives them (`paths`, and `repos` when it knows
 * them), over the row as it is NOW (inside the writer's transaction). A row that
 * records its repos never loses one the writer didn't know of — a repo added to
 * it (add-repo.ts) after the writer read the row, seconds of git work earlier —:
 * those pairs are kept, after the writer's. A row from before (no list) takes
 * what it's given, as it always did. Mutates `existing`.
 */
export function setOwnRepos(existing: WorktreeSession, paths: string[], repos?: string[]): void {
  const recorded = recordedRepos(existing);
  if (!recorded) {
    existing.paths = paths;
    if (repos) existing.repos = [...repos];
    return;
  }
  // The writer's pairs: its own list, else (it knows only the folders) the recorded aliases by place.
  const given =
    repos && repos.length === paths.length
      ? repos.map((alias, i) => ({ alias, path: paths[i] }))
      : paths.length === recorded.length
        ? recorded.map((r, i) => ({ alias: r.alias, path: paths[i] }))
        : recorded;
  const kept = recorded.filter((r) => !given.some((g) => g.alias === r.alias));
  const all = [...given, ...kept];
  existing.paths = all.map((r) => r.path);
  existing.repos = all.map((r) => r.alias);
}

/**
 * Coming back to a session without changing what it holds (`work resume`,
 * `work recent`): its last access, and un-archived, in one write over the row
 * as it is now — never a copy of its folders read before a picker waited on you.
 */
export function touchSession(target: string, branch: string): void {
  tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return;
    s.lastAccessedAt = new Date().toISOString();
    delete s.archivedAt;
    putRow(d, s);
  });
}

export async function upsertSession(
  target: string,
  isGroup: boolean,
  branch: string,
  paths: string[],
  jiraKey?: string,
  baseBranch?: string,
  port?: number,
  /** The repo alias of each of `paths` (WorktreeSession.repos); omitted keeps what the row has. */
  repos?: string[],
  /** The Claude account a NEW session runs on (default: the configured one); an existing session keeps its own. */
  account?: string,
): Promise<void> {
  tx((d) => {
    const existing = getRow(d, target, branch);
    const now = new Date().toISOString();

    if (existing) {
      setOwnRepos(existing, paths, repos);
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
        ...recordAgent(account),
      };
      if (jiraKey) session.jiraKey = jiraKey;
      if (baseBranch) session.baseBranch = baseBranch;
      if (port !== undefined) session.port = port;
      if (repos) session.repos = [...repos];
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
  /** What the session owns: the repo alias of each of `paths` (WorktreeSession.repos) and how
   *  its instructions file is made (`instructions`). Each omitted keeps what the row has. `account`: the Claude
   *  account a NEW session records (default: the configured one) — an existing row keeps its own, never overwritten. */
  own: { repos?: string[]; instructions?: SessionInstructions; account?: string } = {},
): Promise<{ port?: number }> {
  const { repos, instructions, account } = own;
  const hasPerRepo = baseBranches && Object.keys(baseBranches).length > 0;
  const id = sessionIdFor({ target, branch });

  const write = (d: Db, port: number | undefined): number | undefined => {
    const existing = getRow(d, target, branch);
    const now = new Date().toISOString();
    if (existing) {
      setOwnRepos(existing, paths, repos);
      existing.lastAccessedAt = now;
      delete existing.archivedAt; // coming back to it un-archives it
      if (jiraKey) existing.jiraKey = jiraKey;
      if (baseBranch && !existing.baseBranch) existing.baseBranch = baseBranch;
      if (hasPerRepo && !existing.baseBranches) existing.baseBranches = baseBranches;
      if (existing.port === undefined && port !== undefined) existing.port = port;
      if (instructions) existing.instructions = instructions;
      putRow(d, existing);
      return existing.port;
    }
    const session: WorktreeSession = { target, isGroup, branch, paths, createdAt: now, lastAccessedAt: now, ...recordAgent(account) };
    if (jiraKey) session.jiraKey = jiraKey;
    if (baseBranch) session.baseBranch = baseBranch;
    if (hasPerRepo) session.baseBranches = baseBranches;
    if (port !== undefined) session.port = port;
    if (repos) session.repos = [...repos];
    if (instructions) session.instructions = instructions;
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
        const taken = rows(d).some((s) => sessionIdFor(s) !== id && s.port === port && s.paths.some((p) => fs.existsSync(p)));
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
export async function setSessionArchived(target: string, branch: string, archived: boolean): Promise<boolean> {
  return tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return false;
    if (archived) s.archivedAt = new Date().toISOString();
    else delete s.archivedAt;
    putRow(d, s);
    return true;
  });
}

/** Name a session (an empty title goes back to the automatic name). */
export async function setSessionTitle(target: string, branch: string, title: string): Promise<boolean> {
  return tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return false;
    const t = title.trim().slice(0, 120);
    if (t) s.title = t;
    else delete s.title;
    putRow(d, s);
    return true;
  });
}

/** Record the Claude account a session runs on (a switch of account): in one transaction. False for an unknown session. */
export async function setSessionAccount(target: string, branch: string, account: string): Promise<boolean> {
  return tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return false;
    s.account = account;
    putRow(d, s);
    return true;
  });
}

/**
 * Record the branches it is now based on (a stacked session moved onto
 * main): by checkout path. One name for every repo is `baseBranch` alone;
 * repos with different mainlines (main and master) keep `baseBranches` too.
 */
export async function setSessionBase(target: string, branch: string, bases: Record<string, string>): Promise<boolean> {
  const names = [...new Set(Object.values(bases))];
  if (names.length === 0) return false;
  return tx((d) => {
    const s = getRow(d, target, branch);
    if (!s) return false;
    s.baseBranch = names[0];
    if (names.length === 1) delete s.baseBranches;
    else s.baseBranches = { ...bases };
    putRow(d, s);
    return true;
  });
}

export async function removeSession(target: string, branch: string): Promise<void> {
  const id = sessionIdFor({ target, branch });
  if (!withDb((d) => getRow(d, target, branch))) return; // nothing to remove: touch nothing
  const session = findSession(loadHistory(), target, branch);
  // The session's other state (status, comments, saved PTY entry, …) goes
  // with it — in the SAME transaction, so a crash can't leave state behind
  // for a re-created session to inherit (see session-store.ts).
  stopSessionDevServer(id);
  const removed = tx((d) => {
    const gone = d.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
    if (gone) purgeSessionRows(d, id);
    return gone;
  });
  if (removed) {
    removeSessionFiles(id);
    if (session) clearSessionCheckpoints(session);
  }
}

export function getSessionsForTarget(sessions: WorktreeSession[], target: string): WorktreeSession[] {
  return sessions.filter((s) => s.target === target);
}

export function getRecentSessions(sessions: WorktreeSession[], count: number): WorktreeSession[] {
  return [...sessions]
    .sort((a, b) => new Date(effectiveLastAccessedAt(b)).getTime() - new Date(effectiveLastAccessedAt(a)).getTime())
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
 * A session that records its repos (`repos`) owns its list: its paths keep
 * their order and none is dropped; a folder found on disk that it lacks is
 * added at the end, with its repo.
 */
export async function mergeHydratedSessions(incoming: WorktreeSession[]): Promise<{ added: number; updated: number }> {
  return tx((d) => {
    let added = 0;
    let updated = 0;

    for (const inc of incoming) {
      const existing = getRow(d, inc.target, inc.branch);
      const own = existing ? recordedRepos(existing) : null;
      if (existing && own) {
        const extra = inc.paths
          .map((p, i) => ({ path: p, alias: inc.repos?.[i] }))
          .filter((x) => !own.some((r) => samePath(r.path, x.path)));
        // Without its repo a new folder can't be recorded beside the others: the list stays as it is.
        if (extra.length && extra.every((x) => typeof x.alias === 'string')) {
          existing.paths = [...existing.paths, ...extra.map((x) => x.path)];
          existing.repos = [...own.map((r) => r.alias), ...extra.map((x) => x.alias as string)];
          putRow(d, existing);
          updated++;
        }
      } else if (existing) {
        const sortedA = [...existing.paths].sort();
        const sortedB = [...inc.paths].sort();
        const same = sortedA.length === sortedB.length && sortedA.every((p, i) => p === sortedB[i]);
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

const samePath = (a: string, b: string) => {
  const n = (p: string) => path.resolve(p).split(path.sep).join('/').toLowerCase();
  return n(a) === n(b);
};

/**
 * A base checkout (`work tree <target>` with no branch) is recorded under the
 * branch it had checked out at the time. Run it again after switching that
 * checkout to another branch and a second entry appeared for the SAME folder
 * — then a third… — each showing the folder's activity as its own (three
 * "Active" rows for one busy checkout). Keep one: the entry just recorded.
 * Returns the branches of the entries removed.
 */
export async function forgetOtherBaseCheckoutEntries(target: string, keepBranch: string, repoPath: string): Promise<string[]> {
  const others = loadHistory().filter(
    (s) => s.target === target && !s.isGroup && s.branch !== keepBranch && s.paths.length === 1 && samePath(s.paths[0], repoPath),
  );
  for (const s of others) await removeSession(s.target, s.branch);
  return others.map((s) => s.branch);
}
