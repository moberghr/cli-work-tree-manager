import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getConfigDir } from './config.js';
import { importLegacyState } from './db-import.js';

/**
 * The session-state database, ~/.work/state.db (SQLite, WAL).
 *
 * Every `work` process shares it — the CLI, one `work hook` process per
 * Claude event, work web, the PTY host — so it replaces the per-file lock +
 * atomic-rewrite dance that each JSON state file needed (§5.2). Writers
 * that must see-then-change use `tx()` (BEGIN IMMEDIATE: one writer at a
 * time across processes, others wait up to `timeout`).
 *
 * Rows hold each record as JSON (`data`) beside the columns we look things
 * up by — the shapes the code already uses, with transactions, per-row
 * writes and one place to delete a session (`purgeSessionRows`).
 *
 * This is the only module that imports the SQLite engine (architecture
 * test), so swapping it (e.g. to node:sqlite) is one file.
 *
 * Connection lifetime: long-lived processes keep one connection (cheap
 * queries, ~0.2 ms). With WORK_DB_EPHEMERAL=1 (tests) each outermost call
 * opens and closes it, so a test's temp HOME can be deleted on Windows.
 */

export type Db = Database.Database;

/** 1: the first schema (and the JSON import). 2: pr_replies. */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  branch TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (target, branch)
);

CREATE TABLE IF NOT EXISTS session_status (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS comments (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (store, id)
);

CREATE TABLE IF NOT EXISTS comment_deliveries (
  session_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  PRIMARY KEY (session_id, comment_id)
);

CREATE TABLE IF NOT EXISTS pty_sessions (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS pr_watch_seen (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS dev_runs (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);

-- Review threads handed to a session's Claude, and the reply it drafted
-- for you to post (pr-replies.ts).
CREATE TABLE IF NOT EXISTS pr_replies (
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, thread_id)
);

CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, data TEXT NOT NULL);

-- Change counters, so a long-lived reader (work web's sidebar) can notice
-- another process's writes by polling one row instead of watching files.
INSERT OR IGNORE INTO meta (key, value) VALUES ('rev:sessions', '0'), ('rev:tasks', '0');
CREATE TRIGGER IF NOT EXISTS sessions_rev_i AFTER INSERT ON sessions BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:sessions'; END;
CREATE TRIGGER IF NOT EXISTS sessions_rev_u AFTER UPDATE ON sessions BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:sessions'; END;
CREATE TRIGGER IF NOT EXISTS sessions_rev_d AFTER DELETE ON sessions BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:sessions'; END;
CREATE TRIGGER IF NOT EXISTS tasks_rev_i AFTER INSERT ON tasks BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:tasks'; END;
CREATE TRIGGER IF NOT EXISTS tasks_rev_u AFTER UPDATE ON tasks BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:tasks'; END;
CREATE TRIGGER IF NOT EXISTS tasks_rev_d AFTER DELETE ON tasks BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev:tasks'; END;
`;

export function dbPath(): string {
  return path.join(getConfigDir(), 'state.db');
}

const isBusy = (err: unknown) => /SQLITE_BUSY|database is locked/i.test(String((err as { code?: string }).code ?? err));

/** Retry `fn` while the database is busy. The busy timeout covers normal
 *  reads and writes, but not every step: switching a brand-new file to WAL
 *  while another process is doing the same fails at once with "database is
 *  locked". Seen with four processes starting together. */
function retryBusy<T>(fn: () => T, deadlineMs = 15_000): T {
  const until = Date.now() + deadlineMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || Date.now() > until) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/** Most the write-ahead log (`state.db-wal`) keeps between checkpoints. */
export const WAL_SIZE_LIMIT = 4 * 1024 * 1024;

function open(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file, { timeout: 10_000 });
  try {
    retryBusy(() => d.pragma('journal_mode = WAL'));
    d.pragma('synchronous = NORMAL');
    // SQLite folds the WAL back into the database at ~4 MB but never shrinks
    // the file; this truncates it to at most 4 MB after each checkpoint.
    d.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT}`);
    retryBusy(() => migrate(d, path.dirname(file)));
  } catch (err) {
    d.close();
    throw err;
  }
  return d;
}

/** Create the schema and, the first time, import the old JSON files — in
 *  one IMMEDIATE transaction, so two processes starting together can't
 *  both import. */
function migrate(d: Db, configDir: string): void {
  if ((d.pragma('user_version', { simple: true }) as number) >= SCHEMA_VERSION) return;
  let imported: string[] = [];
  d.transaction(() => {
    // Re-check under the write lock: another process may have just done it.
    const from = d.pragma('user_version', { simple: true }) as number;
    if (from >= SCHEMA_VERSION) return;
    d.exec(SCHEMA); // every statement is IF NOT EXISTS: a later version only adds its tables
    if (from < 1) {
      imported = importLegacyState(d, configDir);
      d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_at', ?)").run(new Date().toISOString());
    }
    d.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
  // Keep the old files (renamed), so a downgrade can go back to them.
  for (const f of imported) {
    try {
      fs.renameSync(f, `${f}.migrated`);
    } catch {
      /* in use or gone — it is already imported, and never read again */
    }
  }
}

const ephemeral = () => process.env.WORK_DB_EPHEMERAL === '1';

let conn: { file: string; db: Db } | null = null;
let depth = 0;

/** Run `fn` with the database. */
export function withDb<T>(fn: (d: Db) => T): T {
  const file = dbPath();
  if (!conn || conn.file !== file) {
    if (conn && depth === 0) conn.db.close();
    conn = { file, db: open(file) };
  }
  const current = conn;
  depth++;
  try {
    return fn(current.db);
  } finally {
    depth--;
    if (depth === 0 && ephemeral() && conn === current) {
      current.db.close();
      conn = null;
    }
  }
}

/** A write transaction: BEGIN IMMEDIATE, so a read-then-write can't race
 *  another process. Nested calls become savepoints. */
export function tx<T>(fn: (d: Db) => T): T {
  return withDb((d) => (d.inTransaction ? d.transaction(() => fn(d))() : d.transaction(() => fn(d)).immediate()));
}

/** Close the cached connection (process shutdown, tests). */
export function closeDb(): void {
  if (conn && depth === 0) {
    conn.db.close();
    conn = null;
  }
}

/** Change counter for `sessions` or `tasks` — bumps on every write by any
 *  process. */
export function revision(table: 'sessions' | 'tasks'): number {
  return withDb((d) => {
    const row = d.prepare('SELECT value FROM meta WHERE key = ?').get(`rev:${table}`) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  });
}

/** Every row a session owns, outside `sessions` itself. */
export function purgeSessionRows(d: Db, sessionId: string): void {
  for (const table of ['session_status', 'comment_deliveries', 'pty_sessions', 'pr_watch_seen', 'dev_runs', 'pr_replies']) {
    d.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
  }
  d.prepare('DELETE FROM comments WHERE store = ?').run(sessionId);
}

/** JSON.parse that returns `unknown` (and null on bad JSON): stored rows
 *  are only trusted after the caller checks their shape. */
export const json = {
  parse(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  },
};
