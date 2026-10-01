import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackBase, stackChildCounts, stackParent, stackParents, type StackSubject } from '../../src/core/stack.js';
import { sessionStacks } from '../../src/core/stack-sessions.js';
import { BehindCache, behindMain, updateFromMain } from '../../src/core/behind-main.js';
import { syncStackChild } from '../../src/core/stack-sync.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

const s = (id: string, branch: string, over: Partial<StackSubject> = {}): StackSubject => ({ id, target: 'api', branch, ...over });

describe('stack detection (pure)', () => {
  it('stacked on the live session of the same project whose branch it was made from', () => {
    const parent = s('p', 'feat/x');
    const child = s('c', 'feat/x-2', { baseBranch: 'feat/x' });
    expect(stackParent(child, [parent, child])).toBe(parent);
    expect(stackParent(parent, [parent, child])).toBeNull();
  });

  it('not on a mainline, a remote ref, an archived session, another project, or one the caller rules out', () => {
    const all = [s('m', 'main'), s('dev', 'develop'), s('a', 'feat/a', { archivedAt: 'x' }), s('o', 'feat/o', { target: 'web' }), s('q', 'feat/q')];
    expect(stackParent(s('1', 'b1', { baseBranch: 'main' }), all)).toBeNull();
    expect(stackParent(s('2', 'b2', { baseBranch: 'develop' }), all)).toBeNull();
    expect(stackParent(s('3', 'b3', { baseBranch: 'origin/feat/q' }), all)).toBeNull();
    expect(stackParent(s('4', 'b4', { baseBranch: 'feat/a' }), all)).toBeNull();
    expect(stackParent(s('5', 'b5', { baseBranch: 'feat/o' }), all)).toBeNull();
    expect(stackParent(s('6', 'b6', { baseBranch: 'feat/q' }), all, (p) => p.id !== 'q')).toBeNull();
    expect(stackParent(s('7', 'b7', { baseBranch: 'feat/q', archivedAt: 'x' }), all)).toBeNull(); // archived child
  });

  it('a group: stacked when every repo was made from the same branch', () => {
    expect(stackBase({ baseBranches: { '/a': 'feat/x', '/b': 'feat/x' } })).toBe('feat/x');
    expect(stackBase({ baseBranches: { '/a': 'feat/x', '/b': 'feat/y' } })).toBeNull();
    expect(stackBase({ baseBranch: 'feat/x' })).toBe('feat/x');
  });

  it('children per parent', () => {
    const all = [s('p', 'feat/x'), s('c1', 'c1', { baseBranch: 'feat/x' }), s('c2', 'c2', { baseBranch: 'feat/x' }), s('g', 'g', { baseBranch: 'c1' })];
    const parents = stackParents(all);
    expect([...parents].map(([id, p]) => [id, p.id])).toEqual([['c1', 'p'], ['c2', 'p'], ['g', 'c1']]);
    expect(stackChildCounts(parents)).toEqual(new Map([['p', 2], ['c1', 1]]));
  });

  it("a repo's own checkout is never a parent (sessionStacks)", () => {
    const now = new Date().toISOString();
    const base: WorktreeSession = { target: 'api', branch: 'feat/base-checkout', isGroup: false, paths: ['/src/api'], createdAt: now, lastAccessedAt: now };
    const child: WorktreeSession = { ...base, branch: 'feat/c', paths: ['/wt/api/feat-c'], baseBranch: 'feat/base-checkout' };
    expect(sessionStacks([base, child], { worktreesRoot: '/wt', repos: { api: '/src/api' }, groups: {}, copyFiles: [] }).parentOf.size).toBe(0);
    expect(sessionStacks([base, child], { worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [] }).parentOf.size).toBe(1);
  });
});

// ---- against real git: a repo, a parent worktree, a child worktree made from it ----

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixture: string;
let tmp: string;
let parentWt: string;
let childWt: string;
beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-fixture-'));
  const repo = path.join(fixture, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
  fs.cpSync(fixture, tmp, { recursive: true });
  const repo = path.join(tmp, 'repo');
  parentWt = path.join(tmp, 'wt-parent');
  childWt = path.join(tmp, 'wt-child');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/p', parentWt);
  fs.writeFileSync(path.join(parentWt, 'p.txt'), 'p1\n');
  git(parentWt, 'add', '.');
  git(parentWt, 'commit', '-q', '-m', 'p1');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/c', childWt, 'feat/p');
  fs.writeFileSync(path.join(childWt, 'c.txt'), 'c1\n');
  git(childWt, 'add', '.');
  git(childWt, 'commit', '-q', '-m', 'c1');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function parentCommits(file: string, content: string, n = 1) {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(parentWt, file), `${content} ${i}\n`);
    git(parentWt, 'add', '.');
    git(parentWt, 'commit', '-q', '-m', `parent ${i}`);
  }
}

describe('behind the parent, and Update from it', () => {
  it("measures against the parent's local branch (nothing fetched), and says it's the stack", async () => {
    expect(await behindMain(childWt, undefined, 'feat/p')).toEqual({ base: 'feat/p', commits: 0, conflicts: false, stacked: true });
    parentCommits('p.txt', 'more', 2);
    expect(await behindMain(childWt, undefined, 'feat/p')).toEqual({ base: 'feat/p', commits: 2, conflicts: false, stacked: true });
    expect(await behindMain(childWt, undefined, 'feat/gone')).toBeNull();
  });

  it('rebases a never-pushed child onto the parent', async () => {
    parentCommits('p.txt', 'more');
    expect(await updateFromMain(childWt, undefined, 'feat/p')).toMatchObject({ ok: true, how: 'rebase', base: 'feat/p', commits: 1 });
    expect(git(childWt, 'rev-list', '--count', 'HEAD..feat/p')).toBe('0');
    expect(fs.readFileSync(path.join(childWt, 'c.txt'), 'utf8')).toBe('c1\n');
  });

  it('BehindCache: a session that becomes stacked is measured against its parent at once (the old answer is about main)', async () => {
    const run = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
      if (args.includes('--count')) return { code: 0, stdout: args.some((a) => a.includes('refs/heads/feat/p')) ? '1\n' : '40\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const cache = new BehindCache({ run });
    cache.get('c', ['/r']);
    await cache.idle();
    expect(cache.get('c', ['/r'])).toMatchObject({ base: 'origin/main', commits: 40 });
    expect(cache.get('c', ['/r'], 'feat/p')).toBeNull(); // not the main answer
    await cache.idle();
    expect(cache.get('c', ['/r'], 'feat/p')).toMatchObject({ base: 'feat/p', commits: 1, stacked: true });
  });
});

describe('syncStackChild: the parent moved', () => {
  const now = new Date().toISOString();
  const child = (): WorktreeSession => ({ target: 'api', branch: 'feat/c', isGroup: false, paths: [childWt], createdAt: now, lastAccessedAt: now, baseBranch: 'feat/p' });

  it('idle and clean: brought up to date, and its Claude told what changed', async () => {
    parentCommits('p.txt', 'more', 2);
    const tell = vi.fn(async () => {});
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'idle', tell })).toEqual({ updated: true, commits: 2, how: 'rebased on it' });
    expect(git(childWt, 'rev-list', '--count', 'HEAD..feat/p')).toBe('0');
    expect(tell).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('brought up to date with feat/p'));
  });

  it('left alone — and says why — while its Claude works or waits, with uncommitted changes, or when it would conflict', async () => {
    parentCommits('p.txt', 'more');
    const before = git(childWt, 'rev-parse', 'HEAD');
    const tell = vi.fn(async () => {});
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'working', tell })).toEqual({ updated: false, why: 'its Claude is working' });
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'needs_input', tell })).toMatchObject({ updated: false });
    fs.writeFileSync(path.join(childWt, 'wip.txt'), 'wip\n');
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'idle', tell })).toEqual({ updated: false, why: 'it has uncommitted changes' });
    fs.rmSync(path.join(childWt, 'wip.txt'));
    fs.writeFileSync(path.join(childWt, 'p.txt'), 'mine\n');
    git(childWt, 'commit', '-qam', 'mine');
    const mine = git(childWt, 'rev-parse', 'HEAD');
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'idle', tell })).toMatchObject({ updated: false, why: expect.stringContaining('would conflict') });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(mine);
    expect(before).not.toBe(mine);
    expect(tell).not.toHaveBeenCalled();
    expect(git(childWt, 'status', '--porcelain')).toBe('');
  });

  it('nothing new: nothing done', async () => {
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'idle', tell: async () => {} })).toEqual({ updated: false, why: 'already on top of feat/p' });
  });
});

describe('POST /api/sessions/:id/update-from-main on a stacked session', () => {
  it('updates from the parent, not main', async () => {
    const { Hono } = await import('hono');
    const { saveHistory } = await import('../../src/core/history.js');
    const { saveConfig } = await import('../../src/core/config.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { mountUpdateRoutes } = await import('../../src/core/update-routes.js');
    const now = new Date().toISOString();
    saveConfig({ worktreesRoot: tmp, repos: { api: path.join(tmp, 'repo') }, groups: {}, copyFiles: [] });
    const parent: WorktreeSession = { target: 'api', branch: 'feat/p', isGroup: false, paths: [parentWt], createdAt: now, lastAccessedAt: now };
    const c: WorktreeSession = { ...parent, branch: 'feat/c', paths: [childWt], baseBranch: 'feat/p' };
    saveHistory([parent, c]);
    parentCommits('p.txt', 'more');
    const app = new Hono();
    mountUpdateRoutes(app, { broadcast: () => {} });
    const r = await app.request(`/api/sessions/${sessionIdFor(c)}/update-from-main`, { method: 'POST' });
    expect(await r.json()).toEqual({ results: [{ ok: true, repo: 'wt-child', how: 'rebase', base: 'feat/p', commits: 1 }] });
  });
});
