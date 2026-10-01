import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { forkBases, forkPrompt, forkSession, type ForkDeps } from '../../src/core/fork.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

const now = new Date().toISOString();
const parent: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api/feat-x'], createdAt: now, lastAccessedAt: now };
const group: WorktreeSession = { target: 'shop', branch: 'feat/y', isGroup: true, paths: ['/wt/shop/feat-y/backend', '/wt/shop/feat-y/web'], createdAt: now, lastAccessedAt: now };

describe('forkBases', () => {
  it('each repo starts from the branch its checkout is on (Claude may have switched it)', () => {
    expect(forkBases(parent, [], () => 'feat/x-v2')).toEqual({ ok: true, spec: { default: 'feat/x-v2', perRepo: {} } });
    const repos = [{ alias: 'be', repoPath: '/src/backend' }, { alias: 'fe', repoPath: '/src/web' }];
    const branchOf = (p: string) => (p.endsWith('backend') ? 'feat/y' : 'feat/y-ui');
    expect(forkBases(group, repos, branchOf)).toEqual({ ok: true, spec: { perRepo: { be: 'feat/y', fe: 'feat/y-ui' } } });
  });

  it('a detached HEAD or a repo the session lacks: an error saying which', () => {
    expect(forkBases(parent, [], () => null)).toMatchObject({ ok: false, error: expect.stringContaining('detached') });
    const repos = [{ alias: 'be', repoPath: '/src/backend' }, { alias: 'docs', repoPath: '/src/docs' }];
    expect(forkBases(group, repos, () => 'feat/y')).toEqual({ ok: false, error: 'docs: not in this session' });
  });
});

describe('forkPrompt', () => {
  it('where it came from, where to work (not the original folder), the summary, then what to do', () => {
    const p = forkPrompt(parent, { branch: 'feat/x-2', paths: ['/wt/api/feat-x-2'] }, 'It added the queue; tests pass.', 'Try it with Redis instead', 3);
    expect(p).toContain('a fork of "api · feat/x" (/wt/api/feat-x): branch feat/x-2');
    expect(p).toContain('its 3 uncommitted files stayed behind');
    expect(p).toContain("Work only in this worktree (/wt/api/feat-x-2); don't change files in the original's folder.");
    expect(p).toContain('It added the queue; tests pass.');
    expect(p.trim().endsWith('Try it with Redis instead')).toBe(true);
    const bare = forkPrompt(parent, { branch: 'feat/x-2', paths: ['/wt/b'] }, null, undefined);
    expect(bare).toContain('no recent conversation to summarize');
    expect(bare).toContain('wait for my instruction');
  });
});

describe('forkSession', () => {
  function deps(over: Partial<ForkDeps> = {}) {
    const calls: string[] = [];
    const d: ForkDeps = {
      config: () => ({ worktreesRoot: '/wt', repos: { api: '/src/api' }, groups: {}, copyFiles: [] }),
      repos: () => [{ alias: 'api', repoPath: '/src/api' }],
      branchOf: () => 'feat/x',
      branchExists: () => false,
      validBranch: (n) => !n.includes(' '),
      setup: async (_t, b) => (calls.push(`setup ${b}`), { paths: [`/wt/api/${b.replace(/\//g, '-')}`] }),
      summarize: async () => (calls.push('summarize'), 'A summary.'),
      start: vi.fn(async () => void calls.push('start')),
      sessionIdFor: (s) => `${s.target}:${s.branch}`,
      uncommitted: () => 0,
      ...over,
    };
    return { d, calls };
  }

  it('creates the worktree first (a bad name fails before the slow summary), then summarizes, then starts its Claude', async () => {
    const { d, calls } = deps();
    expect(await forkSession(parent, { branch: ' feat/x-2 ', prompt: 'go' }, d)).toEqual({ ok: true, sessionId: 'api:feat/x-2', paths: ['/wt/api/feat-x-2'], summarized: true });
    expect(calls).toEqual(['setup feat/x-2', 'summarize', 'start']);
    expect(vi.mocked(d.start).mock.calls[0][1]).toContain('A summary.');
  });

  it('refuses: archived, its own branch, a bad name, a branch that exists, a detached HEAD — before creating anything', async () => {
    const cases: Array<[WorktreeSession, string, Partial<ForkDeps>, RegExp]> = [
      [{ ...parent, archivedAt: now }, 'feat/x-2', {}, /archived/],
      [parent, 'feat/x', {}, /branch of its own/],
      [parent, 'bad name', {}, /not a valid branch name/],
      [parent, 'feat/x-2', { branchExists: () => true }, /already exists \(api\)/],
      [parent, 'feat/x-2', { branchOf: () => null }, /detached/],
    ];
    for (const [s, branch, over, re] of cases) {
      const { d, calls } = deps(over);
      const r = await forkSession(s, { branch }, d);
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(re) });
      expect(calls).toEqual([]);
    }
  });

  it('once the worktree exists, a summary or a start that fails is reported, not fatal', async () => {
    const { d } = deps({ summarize: async () => { throw new Error('claude missing'); }, start: async () => { throw new Error('host down'); } });
    expect(await forkSession(parent, { branch: 'feat/x-2' }, d)).toMatchObject({ ok: true, summarized: false, startError: 'host down' });
  });
});

describe('POST /api/sessions/:id/fork (real git)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let tmp: string;
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-')));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it("forks from the session's branch tip into a new worktree, and starts its Claude with the fork prompt", async () => {
    const { saveConfig } = await import('../../src/core/config.js');
    const { upsertSession, loadHistory } = await import('../../src/core/history.js');
    const { createSingleWorktree } = await import('../../src/core/worktree.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { defaultForkDeps, mountForkRoutes } = await import('../../src/core/fork-routes.js');
    const repo = path.join(tmp, 'api');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const config = { worktreesRoot: path.join(tmp, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] };
    saveConfig(config);
    const wt = path.join(config.worktreesRoot, 'api', 'feat-x');
    expect(createSingleWorktree(repo, wt, 'feat/x', config)).toBe(true);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'work\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'work on x');
    await upsertSession('api', false, 'feat/x', [wt]);

    const start = vi.fn(async () => 'started');
    const app = new Hono();
    const events: string[] = [];
    mountForkRoutes(app, { broadcast: (e) => void events.push(e), deps: defaultForkDeps({ summarize: async () => 'It did x.', uncommitted: () => 0, start }) });
    const post = (body: unknown) =>
      app.request(`/api/sessions/${sessionIdFor({ target: 'api', branch: 'feat/x' })}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const r = await post({ branch: 'feat/x-2', name: 'Try two' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sessionId: string; paths: string[]; summarized: boolean };
    expect(body).toMatchObject({ sessionId: sessionIdFor({ target: 'api', branch: 'feat/x-2' }), summarized: true });
    const forked = body.paths[0];
    expect(git(forked, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x-2');
    expect(git(forked, 'rev-parse', 'HEAD')).toBe(git(wt, 'rev-parse', 'HEAD')); // from the session's tip, not main
    expect(loadHistory().find((s) => s.branch === 'feat/x-2')?.title).toBe('Try two');
    expect(start).toHaveBeenCalledWith(body.sessionId, expect.stringContaining('It did x.'));
    expect(events).toContain('sessions-changed');

    // Again with the same name: it exists now.
    expect((await post({ branch: 'feat/x-2' })).status).toBe(409);
  });
});
