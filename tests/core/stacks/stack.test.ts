import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackBase, stackChildCounts, stackParent, stackParents, type StackSubject } from '../../../src/core/stacks/stack.js';
import { sessionStacks } from '../../../src/core/stacks/stack-sessions.js';
import { BehindCache, behindMain, updateFromMain } from '../../../src/core/stacks/behind-main.js';
import { syncStackChild, syncStacksAfterTurn } from '../../../src/core/stacks/stack-sync.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

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
    expect(await syncStackChild(child(), 'feat/p', { shownState: () => 'idle', tell })).toEqual({ updated: true, commits: 2, how: 'rebased on it', told: true });
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
    const { saveHistory } = await import('../../../src/core/sessions/history.js');
    const { saveConfig } = await import('../../../src/core/platform/config.js');
    const { sessionIdFor } = await import('../../../src/core/sessions/session-id.js');
    const { mountUpdateRoutes } = await import('../../../src/server/routes/update-routes.js');
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

describe('review fixes', () => {
  const now = new Date().toISOString();

  it('sessions made from each other form a cycle, not a stack: none gets a parent', () => {
    const all = [s('a', 'feat/a', { baseBranch: 'feat/b' }), s('b', 'feat/b', { baseBranch: 'feat/a' }), s('c', 'feat/c', { baseBranch: 'feat/x' }), s('x', 'feat/x')];
    expect([...stackParents(all).keys()]).toEqual(['c']);
  });

  it('a group is all or nothing: when the second repo fails, the first is put back', async () => {
    // A second repo, the same shape as the first (parent + child worktrees).
    const repo2 = path.join(tmp, 'repo2');
    fs.cpSync(path.join(fixture, 'repo'), repo2, { recursive: true });
    const p2 = path.join(tmp, 'wt-parent2');
    const c2 = path.join(tmp, 'wt-child2');
    git(repo2, 'worktree', 'add', '-q', '-b', 'feat/p', p2);
    git(repo2, 'worktree', 'add', '-q', '-b', 'feat/c', c2, 'feat/p');
    parentCommits('p.txt', 'more');
    fs.writeFileSync(path.join(p2, 'q.txt'), 'q\n');
    git(p2, 'add', '.');
    git(p2, 'commit', '-q', '-m', 'p2');
    const before1 = git(childWt, 'rev-parse', 'HEAD');
    const before2 = git(c2, 'rev-parse', 'HEAD');
    const { defaultRunner } = await import('../../../src/core/pr/ship.js');
    // The second repo's rebase fails for a reason merge-tree can't see (a hook, a disk).
    const run: typeof defaultRunner = (cmd, args, cwd) =>
      args.includes('rebase') && !args.includes('--abort') && args[1] === c2 ? Promise.resolve({ code: 1, stdout: '', stderr: 'error: disk full' }) : defaultRunner(cmd, args, cwd);
    const group: WorktreeSession = { target: 'shop', branch: 'feat/c', isGroup: true, paths: [childWt, c2], createdAt: now, lastAccessedAt: now, baseBranches: { [childWt]: 'feat/p', [c2]: 'feat/p' } };
    const tell = vi.fn(async () => {});
    const r = await syncStackChild(group, 'feat/p', { run, shownState: () => 'idle', tell });
    expect(r).toMatchObject({ updated: false, why: expect.stringContaining('the others were put back') });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before1);
    expect(git(c2, 'rev-parse', 'HEAD')).toBe(before2);
    expect(git(childWt, 'status', '--porcelain')).toBe('');
    expect(tell).not.toHaveBeenCalled();
  });

  it("asks again right before changing anything: a turn that started while git looked isn't run over", async () => {
    parentCommits('p.txt', 'more');
    const before = git(childWt, 'rev-parse', 'HEAD');
    const states: Array<'idle' | 'working'> = ['idle', 'working'];
    const c: WorktreeSession = { target: 'api', branch: 'feat/c', isGroup: false, paths: [childWt], createdAt: now, lastAccessedAt: now, baseBranch: 'feat/p' };
    expect(await syncStackChild(c, 'feat/p', { shownState: () => states.shift() ?? 'working', tell: async () => {} })).toEqual({ updated: false, why: 'its Claude is working' });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('a note that fails to post: still updated, and said so', async () => {
    parentCommits('p.txt', 'more');
    const c: WorktreeSession = { target: 'api', branch: 'feat/c', isGroup: false, paths: [childWt], createdAt: now, lastAccessedAt: now, baseBranch: 'feat/p' };
    expect(await syncStackChild(c, 'feat/p', { shownState: () => 'idle', tell: async () => { throw new Error('work web gone'); } })).toMatchObject({ updated: true, told: false });
  });

  describe('syncStacksAfterTurn', () => {
    const sessions = (): WorktreeSession[] => [
      { target: 'api', branch: 'feat/p', isGroup: false, paths: [parentWt], createdAt: now, lastAccessedAt: now },
      { target: 'api', branch: 'feat/c', isGroup: false, paths: [childWt], createdAt: now, lastAccessedAt: now, baseBranch: 'feat/p' },
    ];
    const deps = (over: Record<string, unknown> = {}) => {
      const notes: string[] = [];
      const invalidated: string[] = [];
      return {
        notes,
        invalidated,
        d: {
          history: sessions,
          config: () => ({ worktreesRoot: tmp, repos: { api: path.join(tmp, 'repo') }, groups: {}, copyFiles: [] }),
          invalidate: (id: string) => void invalidated.push(id),
          startRun: () => ({ note: (t: string) => void notes.push(t), done: () => {} }),
          busy: new Set<string>(),
          shownState: () => 'idle' as const,
          tell: async () => {},
          ...over,
        },
      };
    };
    const id = async (branch: string) => (await import('../../../src/core/sessions/session-id.js')).sessionIdFor({ target: 'api', branch });

    it("after the parent's turn: its children brought up to date, and noted", async () => {
      parentCommits('p.txt', 'more');
      const { d, notes, invalidated } = deps();
      expect(await syncStacksAfterTurn(await id('feat/p'), d)).toBe(1);
      expect(notes[0]).toContain('feat/c: 1 commit from feat/p (rebased on it); its Claude was told');
      expect(invalidated).toContain(await id('feat/c'));
    });

    it("after the child's own turn too (its parent moved while it worked)", async () => {
      parentCommits('p.txt', 'more');
      expect(await syncStacksAfterTurn(await id('feat/c'), deps().d)).toBe(1);
    });

    it('turned off: the chips are refreshed, nothing is changed; one already being updated is skipped', async () => {
      parentCommits('p.txt', 'more');
      const before = git(childWt, 'rev-parse', 'HEAD');
      const off = deps({ config: () => ({ worktreesRoot: tmp, repos: {}, groups: {}, copyFiles: [], stacks: { autoUpdate: false } }) });
      expect(await syncStacksAfterTurn(await id('feat/p'), off.d)).toBe(0);
      expect(off.invalidated).toEqual([await id('feat/c')]);
      const busy = deps({ busy: new Set([await id('feat/c')]) });
      expect(await syncStacksAfterTurn(await id('feat/p'), busy.d)).toBe(0);
      expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before);
    });
  });
});
