import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BehindCache, behindMain, combineBehind, updateFromMain, type Behind } from '../../../src/core/stacks/behind-main.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';

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

  it('a merge a hook refuses is a failure with its reason, not a conflict for Claude to resolve', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/hooked');
    fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'c');
    git(clone, 'push', '-q', '-u', 'origin', 'feat/hooked');
    mainMovesOn('b.txt', 'b');
    const before = git(clone, 'rev-parse', 'HEAD');
    // commit-msg runs on a merge commit too (git merge --no-edit).
    fs.writeFileSync(path.join(clone, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "subject must start with a ticket key" >&2\nexit 1\n', { mode: 0o755 });
    const r = await updateFromMain(clone);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('subject must start with a ticket key') });
    expect(r).not.toHaveProperty('conflicts');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });

  it('already level: nothing to do', async () => {
    git(clone, 'checkout', '-q', '-b', 'feat/level');
    expect(await updateFromMain(clone)).toMatchObject({ ok: true, how: 'nothing', commits: 0 });
  });
});

describe('BehindCache', () => {
  const level: Behind = { base: 'origin/main', commits: 0, conflicts: false };
  /** A runner that answers like a repo `commits` behind, counting what it was asked. */
  function fakeRepo(commits: () => number) {
    const calls: string[][] = [];
    let open = 0;
    let maxOpen = 0;
    const run: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 2));
      open--;
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
      if (args.includes('--count')) return { code: 0, stdout: `${commits()}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls, maxOpen: () => maxOpen };
  }

  it('reads never wait; one look per session at a time; again after the TTL or invalidate; told only on a change', async () => {
    let behind = 0;
    let now = 1_000;
    const repo = fakeRepo(() => behind);
    const onChange = vi.fn();
    const cache = new BehindCache({ run: repo.run, ttlMs: 60_000, now: () => now, onChange });
    expect(cache.get('a', ['/r'])).toBeNull(); // nothing yet, and no waiting
    expect(cache.get('a', ['/r'])).toBeNull(); // in flight: not asked twice
    await cache.idle();
    expect(cache.get('a', ['/r'])).toEqual(level);
    const looks = () => repo.calls.filter((c) => c.includes('--count')).length;
    expect(looks()).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    behind = 5;
    now += 30_000;
    cache.get('a', ['/r']);
    await cache.idle();
    expect(looks()).toBe(1); // within the TTL: cached
    now += 31_000;
    expect(cache.get('a', ['/r'])).toEqual(level); // stale value while it looks again
    await cache.idle();
    expect(cache.get('a', ['/r'])).toMatchObject({ commits: 5 });
    expect(onChange).toHaveBeenCalledTimes(2);

    cache.invalidate('a');
    cache.get('a', ['/r']);
    await cache.idle();
    expect(looks()).toBe(3);
    expect(onChange).toHaveBeenCalledTimes(2); // same answer: nobody told
  });

  it('a couple at a time', async () => {
    const repo = fakeRepo(() => 0);
    const cache = new BehindCache({ run: repo.run, concurrency: 2 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) cache.get(id, ['/r']);
    await cache.idle();
    expect(repo.calls.filter((c) => c.includes('--count'))).toHaveLength(5);
    expect(repo.maxOpen()).toBeLessThanOrEqual(2);
  });
});

describe('POST /api/sessions/:id/update-from-main', () => {
  it("not while its Claude works or waits on you (the files would move under it)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-route-'));
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const { Hono } = await import('hono');
      const { saveHistory } = await import('../../../src/core/sessions/history.js');
      const { recordStatusEvent } = await import('../../../src/core/status/session-status.js');
      const { sessionIdFor } = await import('../../../src/core/sessions/session-id.js');
      const { mountUpdateRoutes } = await import('../../../src/server/routes/update-routes.js');
      const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [clone], createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString() };
      saveHistory([s]);
      await recordStatusEvent(sessionIdFor(s), { kind: 'prompt', prompt: 'go' });
      const app = new Hono();
      mountUpdateRoutes(app, { broadcast: () => {} });
      const r = await app.request(`/api/sessions/${sessionIdFor(s)}/update-from-main`, { method: 'POST' });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: expect.stringContaining('its Claude is working') });
      // A Claude that died mid-turn (no Stop hook): shown idle after 15 quiet minutes, and no longer in the way.
      await recordStatusEvent(sessionIdFor(s), { kind: 'prompt', prompt: 'go' }, new Date(Date.now() - 20 * 60_000));
      const later = await app.request(`/api/sessions/${sessionIdFor(s)}/update-from-main`, { method: 'POST' });
      expect(later.status).toBe(200);
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
