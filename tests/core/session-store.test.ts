import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveHistory, removeSession, prunePersistedStaleEntries, upsertSession, loadHistory } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { sessionStatePaths } from '../../src/core/session-store.js';
import { saveConfig, loadConfig } from '../../src/core/config.js';

/**
 * Removing a session removes ALL its state (reviewed: status and comment
 * files were left behind, and a re-created session with the same
 * target:branch inherited them).
 */
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work', 'status'), { recursive: true });
  fs.mkdirSync(path.join(home, '.work', 'comments'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function seedState(target: string, branch: string) {
  const id = sessionIdFor({ target, branch });
  for (const p of sessionStatePaths(id)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{}');
  }
  fs.writeFileSync(
    path.join(home, '.work', 'pty-sessions.json'),
    JSON.stringify({ [id]: { cwd: '/x' }, keep: { cwd: '/y' } }),
  );
  return id;
}
const exists = (id: string) => sessionStatePaths(id).map((p) => fs.existsSync(p));

describe('session-store purge', () => {
  it('removeSession deletes status, comments, delivery markers and the saved PTY entry', async () => {
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    const id = seedState('api', 'feat/x');
    expect(exists(id)).toEqual([true, true, true, true, true]);
    await removeSession('api', 'feat/x');
    expect(exists(id)).toEqual([false, false, false, false, false]);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.work', 'pty-sessions.json'), 'utf-8'))).toEqual({
      keep: { cwd: '/y' },
    });
  });

  it('a session re-created with the same target:branch starts clean', async () => {
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    const id = seedState('api', 'feat/x');
    await removeSession('api', 'feat/x');
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    expect(exists(id)).toEqual([false, false, false, false, false]);
  });

  it('removing a session that is not in history touches nothing', async () => {
    const id = seedState('api', 'feat/x');
    await removeSession('api', 'feat/x');
    expect(exists(id)).toEqual([true, true, true, true, true]);
  });

  it('`work status --prune` purges the state of the entries it drops', async () => {
    const wt = path.join(home, 'gone');
    saveHistory([{ target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' }]);
    const id = seedState('api', 'feat/x');
    expect((await prunePersistedStaleEntries()).pruned).toBe(1);
    expect(loadHistory()).toEqual([]);
    expect(exists(id)).toEqual([false, false, false, false, false]);
  });
});

describe('config.json writes are atomic (§5.3)', () => {
  it('writes via temp + rename and leaves no temp file', () => {
    saveConfig({ worktreesRoot: '/wt', repos: { a: '/a' }, groups: {}, copyFiles: [] });
    expect(loadConfig()?.repos).toEqual({ a: '/a' });
    expect(fs.readdirSync(path.join(home, '.work')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
