import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { sessionIdFor } from './session-id.js';
import { report } from './report.js';

/**
 * One-time import of the pre-SQLite JSON state into a fresh state.db.
 * Runs inside db.ts's migration transaction. Anything unreadable is
 * skipped (logged), never fatal — the same as the old loaders, which
 * treated a corrupt file as empty. Returns the files and folders it
 * consumed; the caller renames them to `*.migrated` after the commit.
 *
 *   history.json               → sessions
 *   status/<id>.json           → session_status
 *   comments/<store>.json      → comments (store = session id or scope-<hash>)
 *   comments/<id>.delivered.json → comment_deliveries
 *   pty-sessions.json          → pty_sessions
 *   pr-watch.json, pr-watch/<id>.json → pr_watch_seen
 *   dev/<id>.json              → dev_runs   (the .log files stay)
 *   tasks.json                 → tasks + meta tasks:nextId
 */

type Db = Database.Database;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      report('error', `[work] skipped unreadable ${file} while importing into state.db: ${(err as Error).message}`);
    }
    return undefined;
  }
}

const jsonFiles = (dir: string) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

export function importLegacyState(d: Db, configDir: string): string[] {
  const consumed: string[] = [];
  const at = (...p: string[]) => path.join(configDir, ...p);

  // -- history
  const history = readJson(at('history.json'));
  if (Array.isArray(history)) {
    const ins = d.prepare('INSERT OR IGNORE INTO sessions (id, target, branch, data) VALUES (?, ?, ?, ?)');
    for (const s of history) {
      if (!s || typeof s.target !== 'string' || typeof s.branch !== 'string' || !Array.isArray(s.paths)) continue;
      ins.run(sessionIdFor(s), s.target, s.branch, JSON.stringify(s));
    }
  }
  if (fs.existsSync(at('history.json'))) consumed.push(at('history.json'));

  // -- status
  const insStatus = d.prepare('INSERT OR REPLACE INTO session_status (session_id, data) VALUES (?, ?)');
  for (const f of jsonFiles(at('status'))) {
    const s = readJson(f) as { state?: unknown } | undefined;
    if (s && typeof s.state === 'string') insStatus.run(path.basename(f, '.json'), JSON.stringify(s));
  }
  if (fs.existsSync(at('status'))) consumed.push(at('status'));

  // -- comments + deliveries
  const insComment = d.prepare('INSERT OR IGNORE INTO comments (store, id, data) VALUES (?, ?, ?)');
  const insDelivered = d.prepare('INSERT OR IGNORE INTO comment_deliveries (session_id, comment_id) VALUES (?, ?)');
  for (const f of jsonFiles(at('comments'))) {
    const name = path.basename(f, '.json');
    const data = readJson(f);
    if (!Array.isArray(data)) continue;
    if (name.endsWith('.delivered')) {
      const sid = name.slice(0, -'.delivered'.length);
      for (const id of data) if (typeof id === 'string') insDelivered.run(sid, id);
    } else {
      for (const c of data) if (c && typeof c.id === 'string') insComment.run(name, c.id, JSON.stringify(c));
    }
  }
  if (fs.existsSync(at('comments'))) consumed.push(at('comments'));

  // -- PTY restore list
  const pty = readJson(at('pty-sessions.json'));
  if (pty && typeof pty === 'object' && !Array.isArray(pty)) {
    const ins = d.prepare('INSERT OR REPLACE INTO pty_sessions (session_id, data) VALUES (?, ?)');
    for (const [id, spec] of Object.entries(pty as Record<string, unknown>)) {
      if (spec && typeof spec === 'object') ins.run(id, JSON.stringify(spec));
    }
  }
  if (fs.existsSync(at('pty-sessions.json'))) {
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('pty_sessions:updated_at', ?)").run(new Date().toISOString());
    consumed.push(at('pty-sessions.json'));
  }

  // -- PR watch (the old single capped list, and the per-session files)
  const insSeen = d.prepare('INSERT OR IGNORE INTO pr_watch_seen (session_id, key) VALUES (?, ?)');
  const legacy = readJson(at('pr-watch.json')) as { told?: unknown } | undefined;
  if (legacy && Array.isArray(legacy.told)) {
    for (const k of legacy.told) {
      if (typeof k !== 'string') continue;
      const id = (k.startsWith('rv:') ? k.slice(3) : k).split(':')[0];
      if (id) insSeen.run(id, k);
    }
  }
  if (fs.existsSync(at('pr-watch.json'))) consumed.push(at('pr-watch.json'));
  for (const f of jsonFiles(at('pr-watch'))) {
    const j = readJson(f) as { seen?: unknown } | undefined;
    if (j && Array.isArray(j.seen)) for (const k of j.seen) if (typeof k === 'string') insSeen.run(path.basename(f, '.json'), k);
  }
  if (fs.existsSync(at('pr-watch'))) consumed.push(at('pr-watch'));

  // -- dev-server runs (pid records only; logs stay where they are)
  const insDev = d.prepare('INSERT OR REPLACE INTO dev_runs (session_id, data) VALUES (?, ?)');
  for (const f of jsonFiles(at('dev'))) {
    const r = readJson(f) as { pid?: unknown } | undefined;
    if (r && typeof r.pid === 'number') insDev.run(path.basename(f, '.json'), JSON.stringify(r));
    consumed.push(f);
  }

  // -- tasks
  const tasks = readJson(at('tasks.json')) as { nextId?: unknown; tasks?: unknown } | undefined;
  if (tasks && Array.isArray(tasks.tasks)) {
    const ins = d.prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)');
    let max = 0;
    for (const t of tasks.tasks) {
      if (!t || typeof t.id !== 'number') continue;
      ins.run(t.id, JSON.stringify(t));
      max = Math.max(max, t.id);
    }
    const next = typeof tasks.nextId === 'number' ? Math.max(tasks.nextId, max + 1) : max + 1;
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('tasks:nextId', ?)").run(String(next));
  }
  if (fs.existsSync(at('tasks.json'))) consumed.push(at('tasks.json'));

  return consumed;
}
