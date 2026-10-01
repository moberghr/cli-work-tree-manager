import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { behindMain, combineBehind, updateFromMain } from '../../src/core/behind-main.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// One fixture (an origin with main, a clone), copied per test (testing.md §4.7).
let fixture: string;
let tmp: string;
let origin: string;
let clone: string;
beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'behind-fixture-'));
  const o = path.join(fixture, 'origin.git');
  const c = path.join(fixture, 'clone');
  git(fixture, 'init', '-q', '--bare', '-b', 'main', o);
  git(fixture, 'clone', '-q', o, c);
  fs.writeFileSync(path.join(c, 'a.txt'), 'one\n');
  git(c, 'add', '.');
  git(c, 'commit', '-q', '-m', 'one');
  git(c, 'push', '-q', '-u', 'origin', 'main');
  git(c, 'remote', 'set-head', 'origin', 'main');
});
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'behind-'));
  fs.cpSync(fixture, tmp, { recursive: true });
  origin = path.join(tmp, 'origin.git');
  clone = path.join(tmp, 'clone');
  git(clone, 'remote', 'set-url', 'origin', origin);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Main moves on in another clone and is pushed; `file` changes there. */
function mainMovesOn(file: string, content: string, commits = 1) {
  const other = path.join(tmp, 'other');
  if (!fs.existsSync(other)) git(tmp, 'clone', '-q', origin, other);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(other, file), `${content} ${i}\n`);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', `main ${i}`);
  }
  git(other, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin');
}

describe('behindMain', () => {
  it('level: 0; behind: how many; a conflicting change: says so (merge-tree, nothing touched)', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/x');
    expect(await behindMain(clone)).toEqual({ base: 'origin/main', commits: 0, conflicts: false });
    mainMovesOn('b.txt', 'other file', 3);
    expect(await behindMain(clone)).toEqual({ base: 'origin/main', commits: 3, conflicts: false });
    fs.writeFileSync(path.join(clone, 'a.txt'), 'mine\n');
    git(clone, 'commit', '-qam', 'mine');
    mainMovesOn('a.txt', 'theirs');
    expect(await behindMain(clone)).toMatchObject({ commits: 4, conflicts: true });
    expect(git(clone, 'status', '--porcelain')).toBe(''); // nothing touched
  });

  it('a group: the furthest behind, and any conflict', () => {
    expect(combineBehind([{ base: 'origin/main', commits: 2, conflicts: false }, null, { base: 'origin/dev', commits: 9, conflicts: true }])).toEqual({ base: 'origin/dev', commits: 9, conflicts: true });
    expect(combineBehind([null])).toBeNull();
  });
});

describe('updateFromMain', () => {
  it('a branch never pushed: rebased on origin/main', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/local');
    fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'c');
    mainMovesOn('b.txt', 'b', 2);
    expect(await updateFromMain(clone)).toMatchObject({ ok: true, how: 'rebase', base: 'origin/main', commits: 2 });
    expect(git(clone, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0');
    expect(git(clone, 'log', '--merges', '--oneline')).toBe(''); // no merge commit
  });

  it('a pushed branch: main merged in (a rebase would need a force push)', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/pushed');
    fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'c');
    git(clone, 'push', '-q', '-u', 'origin', 'feat/pushed');
    mainMovesOn('b.txt', 'b');
    expect(await updateFromMain(clone)).toMatchObject({ ok: true, how: 'merge', commits: 1 });
    expect(git(clone, 'log', '--merges', '--oneline')).not.toBe('');
  });

  it('a conflict is aborted at once — the worktree as it was — and reported; uncommitted changes are refused', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/clash');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'mine\n');
    git(clone, 'commit', '-qam', 'mine');
    const before = git(clone, 'rev-parse', 'HEAD');
    mainMovesOn('a.txt', 'theirs');
    expect(await updateFromMain(clone)).toMatchObject({ ok: false, conflicts: true, base: 'origin/main', reason: expect.stringContaining('conflicts') });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(clone, '.git', 'rebase-merge'))).toBe(false);
    fs.writeFileSync(path.join(clone, 'wip.txt'), 'wip\n');
    expect(await updateFromMain(clone)).toMatchObject({ ok: false, reason: expect.stringContaining('uncommitted changes') });
  });

  it('already level: nothing to do', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/level');
    expect(await updateFromMain(clone)).toMatchObject({ ok: true, how: 'nothing', commits: 0 });
  });
});

describe('POST /api/sessions/:id/update-from-main', () => {
  it("not while its Claude works or waits on you (the files would move under it)", async () => {
    const { vi } = await import('vitest');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-route-'));
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const { Hono } = await import('hono');
      const { saveHistory } = await import('../../src/core/history.js');
      const { recordStatusEvent } = await import('../../src/core/session-status.js');
      const { sessionIdFor } = await import('../../src/core/session-id.js');
      const { mountUpdateRoutes } = await import('../../src/core/update-routes.js');
      const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [clone], createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString() };
      saveHistory([s]);
      await recordStatusEvent(sessionIdFor(s), { kind: 'prompt', prompt: 'go' });
      const app = new Hono();
      mountUpdateRoutes(app, { broadcast: () => {} });
      const r = await app.request(`/api/sessions/${sessionIdFor(s)}/update-from-main`, { method: 'POST' });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: expect.stringContaining('its Claude is working') });
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
