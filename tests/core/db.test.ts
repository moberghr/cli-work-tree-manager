import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadHistory } from '../../src/core/history.js';
import { readStatus } from '../../src/core/session-status.js';
import { getCommentFileStore, clearCommentStoreCache } from '../../src/core/comment-file-store.js';
import { readPendingForSession } from '../../src/core/pending-delivery.js';
import { dbPtySessions } from '../../src/core/pty-sessions-file.js';
import { createSeenStores } from '../../src/core/pr-watch-store.js';
import { getTasks, addTask } from '../../src/core/tasks.js';
import { revision, withDb } from '../../src/core/db.js';
import { sessionIdFor } from '../../src/core/session-id.js';

/**
 * state.db: the one-time import of the old JSON files, change counters,
 * and what happens when several processes open it at once.
 */

let home: string;
let work: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-db-'));
  work = path.join(home, '.work');
  fs.mkdirSync(work, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  clearCommentStoreCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (rel: string, data: unknown) => {
  const f = path.join(work, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
};
const session = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api/feat-x'], createdAt: 'c', lastAccessedAt: 'l', port: 3001 };
const id = sessionIdFor(session);

/** A pre-SQLite ~/.work with one of everything. */
function legacyTree() {
  write('history.json', [session, { target: 'web', branch: 'main', isGroup: false, paths: ['/wt/web'], createdAt: 'c', lastAccessedAt: 'l' }, { bogus: true }]);
  write(`status/${id}.json`, { state: 'idle', since: 's', seen: false, updatedAt: 'u', summary: 'done' });
  write(`comments/${id}.json`, [
    { id: 'c1', repo: '', file: '', line: 0, side: 'general', body: 'one', createdAt: '1', author: 'user', status: 'published' },
    { id: 'c2', repo: '', file: '', line: 0, side: 'general', body: 'two', createdAt: '2', author: 'user', status: 'published' },
  ]);
  write(`comments/${id}.delivered.json`, ['c1']);
  write('comments/scope-abc.json', [{ id: 's1', repo: 'r', file: 'f', line: 1, side: 'right', body: 'wd review', createdAt: '3', author: 'user', status: 'published' }]);
  write('pty-sessions.json', { [id]: { cwd: '/wt/api/feat-x', tool: { cmd: 'claude', baseArgs: [] }, startedAt: 't' }, junk: 'x' });
  write('pr-watch.json', { told: [`rv:${id}:api:7:baseline`, `${id}:api:sha1`] });
  write(`pr-watch/${id}.json`, { seen: [`rv:${id}:api:7:t:C9`] });
  write(`dev/${id}.json`, { pid: 99999999, command: 'npm run dev', cwd: '/wt', startedAt: 't' });
  write(`dev/${id}.log`, 'server output');
  write('tasks.json', { nextId: 7, tasks: [{ id: 3, text: 'ship it', done: false, createdAt: 't' }] });
}

describe('first open imports the JSON state', () => {
  it('moves every kind of record, and keeps the old files as *.migrated', () => {
    legacyTree();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(loadHistory().map((s) => s.target)).toEqual(['api', 'web']);
    expect(loadHistory()[0]).toEqual(session);
    expect(readStatus(id)).toMatchObject({ state: 'idle', summary: 'done' });
    expect(getCommentFileStore(id).snapshot().map((c) => c.body)).toEqual(['one', 'two']);
    expect(readPendingForSession(id).map((c) => c.id)).toEqual(['c2']); // c1 was delivered
    expect(getCommentFileStore('scope-abc').snapshot().map((c) => c.body)).toEqual(['wd review']);
    expect(Object.keys(dbPtySessions.read())).toEqual([id]); // the junk entry is dropped
    const seen = createSeenStores()(id);
    expect([`rv:${id}:api:7:baseline`, `${id}:api:sha1`, `rv:${id}:api:7:t:C9`].every((k) => seen.has(k))).toBe(true);
    expect(withDb((d) => d.prepare('SELECT session_id FROM dev_runs').all())).toEqual([{ session_id: id }]);
    expect(getTasks().map((t) => t.text)).toEqual(['ship it']);

    const left = fs.readdirSync(work).sort();
    expect(left).toEqual(
      expect.arrayContaining(['history.json.migrated', 'status.migrated', 'comments.migrated', 'pty-sessions.json.migrated', 'pr-watch.json.migrated', 'pr-watch.migrated', 'tasks.json.migrated', 'state.db', 'dev']),
    );
    expect(left).not.toContain('history.json');
    // The dev log stays where the dev server writes it.
    expect(fs.readdirSync(path.join(work, 'dev')).sort()).toEqual([`${id}.json.migrated`, `${id}.log`]);
  });

  it('keeps the next task id, so a removed task\'s id is not reused', async () => {
    legacyTree();
    expect((await addTask('next')).id).toBe(7);
  });

  it('imports once: files appearing later are ignored', () => {
    legacyTree();
    expect(loadHistory()).toHaveLength(2);
    write('history.json', [{ target: 'late', branch: 'b', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '' }]);
    expect(loadHistory().map((s) => s.target)).toEqual(['api', 'web']);
  });

  it('a fresh machine just gets an empty database', () => {
    expect(loadHistory()).toEqual([]);
    expect(getTasks()).toEqual([]);
    expect(fs.existsSync(path.join(work, 'state.db'))).toBe(true);
  });
});

describe('work state --export', () => {
  it('writes the old JSON layout, and importing that gives back the same state', async () => {
    legacyTree();
    await addTask('added after the move');
    const snapshot = () => ({
      history: loadHistory(),
      status: readStatus(id),
      comments: getCommentFileStore(id).snapshot(),
      scope: getCommentFileStore('scope-abc').snapshot(),
      pending: readPendingForSession(id).map((c) => c.id),
      ptys: dbPtySessions.read(),
      seen: withDb((d) => d.prepare('SELECT session_id, key FROM pr_watch_seen ORDER BY key').all()),
      tasks: getTasks(),
    });
    const before = snapshot();

    const out = path.join(home, 'export');
    const { exportLegacyState, stateSummary } = await import('../../src/core/db-export.js');
    expect(stateSummary().counts).toMatchObject({ sessions: 2, comments: 3, tasks: 2 });
    exportLegacyState(out);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'history.json'), 'utf-8'))).toEqual(before.history);

    // A second machine / a fresh HOME that only has the exported files.
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'work-db2-'));
    fs.cpSync(out, path.join(home2, '.work'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home2);
    clearCommentStoreCache();
    try {
      expect(snapshot()).toEqual(before);
      expect((await addTask('next')).id).toBe(before.tasks.at(-1)!.id + 1);
    } finally {
      fs.rmSync(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe('an old PTY host that outlived the upgrade', () => {
  it("its pty-sessions.json, written after the import, replaces the database's list at the next host start", async () => {
    legacyTree();
    expect(Object.keys(dbPtySessions.read())).toEqual([id]); // imported
    // The v1 host keeps running: it re-creates the old file and records a
    // session started after the upgrade, having forgotten the first one.
    const tool = { cmd: 'claude', baseArgs: [] };
    write('pty-sessions.json', { later: { cwd: '/wt/later', tool, startedAt: 't2' }, junk: 1 });

    const { adoptLegacyRestoreList } = await import('../../src/core/pty-sessions-file.js');
    expect(adoptLegacyRestoreList()).toBe(1);
    expect(dbPtySessions.read()).toEqual({ later: { cwd: '/wt/later', tool, startedAt: 't2' } });
    expect(fs.existsSync(path.join(work, 'pty-sessions.json'))).toBe(false);
    expect(fs.readdirSync(work).some((f) => f.startsWith('pty-sessions.json.adopted-'))).toBe(true);
    // Nothing to adopt the next time.
    expect(adoptLegacyRestoreList()).toBeNull();
  });
});

describe('change counters', () => {
  it('bump on every write to sessions and tasks, from any connection', async () => {
    const s0 = revision('sessions');
    const t0 = revision('tasks');
    withDb((d) => d.prepare('INSERT INTO sessions (id, target, branch, data) VALUES (?, ?, ?, ?)').run('x', 'a', 'b', '{}'));
    expect(revision('sessions')).toBe(s0 + 1);
    await addTask('t');
    expect(revision('tasks')).toBe(t0 + 1);
    expect(revision('sessions')).toBe(s0 + 1);
  });
});

describe('several processes', () => {
  const run = (script: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60_000 }, (err, out, errOut) =>
        err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out),
      ),
    );
  const mod = (rel: string) => JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../src/core', rel)).href);

  it('starting together, they import the old files exactly once', async () => {
    legacyTree();
    const script = path.join(home, 'open.mts');
    fs.writeFileSync(script, `const { loadHistory } = await import(${mod('history.ts')});\nprocess.stdout.write(String(loadHistory().length));\n`);
    const counts = await Promise.all(Array.from({ length: 4 }, () => run(script)));
    expect(counts).toEqual(['2', '2', '2', '2']);
    expect(withDb((d) => d.prepare('SELECT COUNT(*) AS n FROM comments').get())).toEqual({ n: 3 });
  }, 90_000);

  it('concurrent `work tree`s never get the same port', async () => {
    const script = path.join(home, 'port.mts');
    fs.mkdirSync(path.join(home, 'wt'), { recursive: true });
    fs.writeFileSync(
      script,
      `const { upsertSessionWithPort } = await import(${mod('history.ts')});\n` +
        `const n = process.pid;\n` +
        `const r = await upsertSessionWithPort('t' + n, false, 'b', [${JSON.stringify(path.join(home, 'wt'))}], { portRange: { start: 45100, end: 45103 } });\n` +
        `process.stdout.write(String(r.port));\n`,
    );
    const ports = await Promise.all(Array.from({ length: 4 }, () => run(script)));
    expect(new Set(ports).size).toBe(4);
    expect(ports.every((p) => Number(p) >= 45100 && Number(p) <= 45103)).toBe(true);
  }, 90_000);
});
