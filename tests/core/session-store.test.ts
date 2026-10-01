import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveHistory, removeSession, prunePersistedStaleEntries, upsertSession, loadHistory } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { sessionStatePaths } from '../../src/core/session-store.js';
import { saveConfig, loadConfig } from '../../src/core/config.js';
import { withDb } from '../../src/core/db.js';

/**
 * Removing a session removes ALL its state (reviewed: status and comment
 * files were left behind, and a re-created session with the same
 * target:branch inherited them). Its state is one row per table in
 * state.db plus the dev-server log file.
 */
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const TABLES = ['session_status', 'comment_deliveries', 'pty_sessions', 'pr_watch_seen', 'dev_runs'] as const;

function seedState(target: string, branch: string, other = 'keep-me') {
  const id = sessionIdFor({ target, branch });
  withDb((d) => {
    for (const sid of [id, other]) {
      d.prepare('INSERT INTO session_status (session_id, data) VALUES (?, ?)').run(sid, '{}');
      d.prepare('INSERT INTO comment_deliveries (session_id, comment_id) VALUES (?, ?)').run(sid, 'c1');
      d.prepare('INSERT INTO pty_sessions (session_id, data) VALUES (?, ?)').run(sid, '{}');
      d.prepare('INSERT INTO pr_watch_seen (session_id, key) VALUES (?, ?)').run(sid, 'k');
      d.prepare('INSERT INTO dev_runs (session_id, data) VALUES (?, ?)').run(sid, '{"pid":0}');
      d.prepare('INSERT INTO comments (store, id, data) VALUES (?, ?, ?)').run(sid, 'c1', '{}');
    }
  });
  for (const p of sessionStatePaths(id)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'log');
  }
  return id;
}

/** Which of its tables (and files) still hold anything for this session. */
function leftovers(id: string): string[] {
  return withDb((d) => {
    const out: string[] = TABLES.filter((t) => d.prepare(`SELECT 1 FROM ${t} WHERE session_id = ?`).get(id));
    if (d.prepare('SELECT 1 FROM comments WHERE store = ?').get(id)) out.push('comments');
    for (const p of sessionStatePaths(id)) if (fs.existsSync(p)) out.push(path.basename(p));
    return out;
  });
}
const ALL = (id: string) => [...TABLES, 'comments', `${id}.log`, id, id]; // id: its archive folder, then its kept conversations

describe('session-store purge', () => {
  it('removeSession deletes every row and file the session owns, and nobody else\'s', async () => {
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    const id = seedState('api', 'feat/x');
    expect(leftovers(id)).toEqual(ALL(id));
    await removeSession('api', 'feat/x');
    expect(leftovers(id)).toEqual([]);
    expect(leftovers('keep-me')).toEqual([...TABLES, 'comments']);
  });

  it('a session re-created with the same target:branch starts clean', async () => {
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    const id = seedState('api', 'feat/x');
    await removeSession('api', 'feat/x');
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    expect(leftovers(id)).toEqual([]);
  });

  it('removing a session that is not in history touches nothing', async () => {
    const id = seedState('api', 'feat/x');
    await removeSession('api', 'feat/x');
    expect(leftovers(id)).toEqual(ALL(id));
  });

  it('`work status --prune` purges the state of the entries it drops', async () => {
    const wt = path.join(home, 'gone');
    saveHistory([{ target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' }]);
    const id = seedState('api', 'feat/x');
    expect((await prunePersistedStaleEntries()).pruned).toBe(1);
    expect(loadHistory()).toEqual([]);
    expect(leftovers(id)).toEqual([]);
  });
});

describe('config.json writes are atomic (§5.3)', () => {
  it('writes via temp + rename and leaves no temp file', () => {
    saveConfig({ worktreesRoot: '/wt', repos: { a: '/a' }, groups: {}, copyFiles: [] });
    expect(loadConfig()?.repos).toEqual({ a: '/a' });
    expect(fs.readdirSync(path.join(home, '.work')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
