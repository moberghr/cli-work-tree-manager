import fs from 'node:fs';
import path from 'node:path';
import { dbPath, withDb } from './db.js';

/**
 * Read-only views of state.db for `work state`: a summary, and an export
 * in the pre-SQLite JSON layout — so a downgrade (or a curious human) can
 * go back to plain files without losing anything:
 *
 *   <dir>/history.json, status/<id>.json, comments/<store>.json,
 *   comments/<id>.delivered.json, pty-sessions.json, pr-watch/<id>.json,
 *   dev/<id>.json, tasks.json
 */

export interface StateSummary {
  file: string;
  schemaVersion: number;
  migratedAt: string | null;
  counts: Record<string, number>;
}

const TABLES = ['sessions', 'session_status', 'comments', 'comment_deliveries', 'pty_sessions', 'pr_watch_seen', 'dev_runs', 'tasks'];

export function stateSummary(): StateSummary {
  return withDb((d) => {
    const counts: Record<string, number> = {};
    for (const t of TABLES) counts[t] = (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const migrated = d.prepare("SELECT value FROM meta WHERE key = 'migrated_at'").get() as { value: string } | undefined;
    return {
      file: dbPath(),
      schemaVersion: d.pragma('user_version', { simple: true }) as number,
      migratedAt: migrated?.value ?? null,
      counts,
    };
  });
}

type Row = Record<string, string | number>;
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Write the whole database out as the old JSON files. Returns the files written. */
export function exportLegacyState(dir: string): string[] {
  const written: string[] = [];
  const put = (rel: string, data: unknown) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    written.push(f);
  };
  withDb((d) => {
    const all = (sql: string) => d.prepare(sql).all() as Row[];
    const groupBy = (rows: Row[], key: string, value: (r: Row) => unknown) => {
      const out = new Map<string, unknown[]>();
      for (const r of rows) out.set(String(r[key]), [...(out.get(String(r[key])) ?? []), value(r)]);
      return out;
    };

    put('history.json', all('SELECT data FROM sessions ORDER BY rowid').map((r) => parse(String(r.data))));
    for (const r of all('SELECT session_id, data FROM session_status')) put(`status/${r.session_id}.json`, parse(String(r.data)));
    for (const [store, cs] of groupBy(all('SELECT store, data FROM comments ORDER BY rowid'), 'store', (r) => parse(String(r.data)))) {
      put(`comments/${store}.json`, cs);
    }
    for (const [sid, ids] of groupBy(all('SELECT session_id, comment_id FROM comment_deliveries'), 'session_id', (r) => r.comment_id)) {
      put(`comments/${sid}.delivered.json`, ids);
    }
    put('pty-sessions.json', Object.fromEntries(all('SELECT session_id, data FROM pty_sessions').map((r) => [r.session_id, parse(String(r.data))])));
    for (const [sid, keys] of groupBy(all('SELECT session_id, key FROM pr_watch_seen'), 'session_id', (r) => r.key)) {
      put(`pr-watch/${sid}.json`, { seen: keys });
    }
    for (const r of all('SELECT session_id, data FROM dev_runs')) put(`dev/${r.session_id}.json`, parse(String(r.data)));
    const next = d.prepare("SELECT value FROM meta WHERE key = 'tasks:nextId'").get() as { value: string } | undefined;
    const tasks = all('SELECT data FROM tasks ORDER BY id').map((r) => parse(String(r.data)));
    const maxId = Math.max(0, ...tasks.map((t) => (t as { id?: number } | null)?.id ?? 0));
    put('tasks.json', { nextId: next ? Number(next.value) : maxId + 1, tasks });
  });
  return written;
}
