import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { git } from '../../src/core/git.js';
import { defaultRunner } from '../../src/core/ship.js';
import {
  CLEANUP_ARCHIVE_AFTER_MS,
  cleanupVerdict,
  createCleanupJob,
  repoFacts,
  type CleanupSession,
} from '../../src/core/cleanup.js';
import type { CleanupAction, CleanupRepo } from '../../src/core/api-types.js';

const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('cleanupVerdict', () => {
  const repo = (over: Partial<CleanupRepo> = {}): CleanupRepo => ({
    name: 'api', path: '/wt/api', exists: true, readable: true, dirty: 0, ahead: 0, merged: 'contained', base: 'origin/HEAD', baseCheckout: false, ...over,
  });
  const v = (repos: CleanupRepo[], idleMs = 3 * DAY, archived = false) => cleanupVerdict({ repos, lastActiveMs: NOW - idleMs, archived }, NOW);

  it('merged or never committed to, and clean: delete', () => {
    expect(v([repo()])).toMatchObject({ verdict: 'merged', suggested: 'delete' });
    expect(v([repo({ ahead: 3, merged: 'squash' })])).toMatchObject({ verdict: 'merged', suggested: 'delete', reason: expect.stringContaining('Squash-merged') });
  });

  it('never deletes uncommitted work or commits of its own; archives them once a week quiet', () => {
    expect(v([repo({ dirty: 2 })])).toMatchObject({ verdict: 'dirty', suggested: null, reason: '2 uncommitted files' });
    expect(v([repo({ ahead: 4, merged: null })])).toMatchObject({ verdict: 'work', suggested: null, reason: '4 commits not in origin/HEAD' });
    expect(v([repo({ dirty: 1 })], CLEANUP_ARCHIVE_AFTER_MS + 1).suggested).toBe('archive');
    expect(v([repo({ ahead: 1, merged: null })], CLEANUP_ARCHIVE_AFTER_MS + 1, true).suggested).toBeNull(); // archived already
  });

  it('a group is only as clean as its dirtiest repo', () => {
    expect(v([repo(), repo({ name: 'web', dirty: 1 })]).verdict).toBe('dirty');
    expect(v([repo(), repo({ name: 'web', ahead: 2, merged: null })]).verdict).toBe('work');
  });

  it('folder gone: forget; the repo itself, recent use, or unreadable: keep', () => {
    expect(v([repo({ exists: false })])).toMatchObject({ verdict: 'gone', suggested: 'forget' });
    expect(v([])).toMatchObject({ verdict: 'gone' });
    expect(v([repo({ baseCheckout: true })]).verdict).toBe('keep');
    expect(v([repo()], DAY / 2).verdict).toBe('keep');
    expect(v([repo({ readable: false })]).verdict).toBe('keep');
    expect(v([repo({ base: null, ahead: null })]).verdict).toBe('keep');
  });
});

describe('cleanup on real repositories', () => {
  let dir: string;
  let origin: string;
  let main: string;
  const wt: Record<string, string> = {};
  const g = (args: string[], cwd: string) => {
    const r = git(args, cwd);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), text);
    g(['add', '.'], cwd);
    g(['commit', '-q', '-m', msg], cwd);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
    origin = path.join(dir, 'origin.git');
    g(['init', '-q', '--bare', '-b', 'main', origin], dir);
    main = path.join(dir, 'repo');
    g(['clone', '-q', origin, main], dir);
    commit(main, 'README.md', 'v1\n', 'init');
    g(['push', '-q', 'origin', 'main'], main);
    g(['remote', 'set-head', 'origin', 'main'], main);
    for (const name of ['merged', 'squashed', 'work', 'dirty', 'fresh']) {
      wt[name] = path.join(dir, 'wt', name);
      g(['worktree', 'add', '-q', '-b', `feat/${name}`, wt[name], 'origin/main'], main);
    }
    // merged: a commit that then landed on main as-is.
    commit(wt.merged, 'a.txt', 'a\n', 'a');
    g(['push', '-q', 'origin', 'HEAD:main'], wt.merged);
    // squashed: two commits, landed on main as ONE squash commit.
    commit(wt.squashed, 'b.txt', 'b1\n', 'b1');
    commit(wt.squashed, 'b.txt', 'b2\n', 'b2');
    g(['fetch', '-q', 'origin'], main);
    g(['checkout', '-q', '--detach', 'origin/main'], main);
    fs.writeFileSync(path.join(main, 'b.txt'), 'b2\n');
    g(['add', '.'], main);
    g(['commit', '-q', '-m', 'Squash of feat/squashed'], main);
    g(['push', '-q', 'origin', 'HEAD:main'], main);
    // work: a commit of its own, never merged. dirty: an uncommitted file.
    commit(wt.work, 'c.txt', 'c\n', 'c');
    fs.writeFileSync(path.join(wt.dirty, 'notes.txt'), 'wip\n');
    for (const w of Object.values(wt)) g(['fetch', '-q', 'origin'], w);
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const facts = (p: string) => repoFacts('repo', p, new Set(), defaultRunner);

  it('reads merged, squash-merged, own commits and uncommitted work from git', async () => {
    expect(await facts(wt.merged)).toMatchObject({ exists: true, readable: true, dirty: 0, ahead: 0, merged: 'contained' });
    expect(await facts(wt.squashed)).toMatchObject({ dirty: 0, ahead: 2, merged: 'squash' });
    expect(await facts(wt.work)).toMatchObject({ dirty: 0, ahead: 1, merged: null });
    expect(await facts(wt.dirty)).toMatchObject({ dirty: 1 });
    expect(await facts(path.join(dir, 'nope'))).toMatchObject({ exists: false });
  }, 60_000);

  it('never offers the repo itself', async () => {
    const r = await repoFacts('repo', main, new Set([process.platform === 'win32' ? path.resolve(main).toLowerCase() : path.resolve(main)]), defaultRunner);
    expect(r.baseCheckout).toBe(true);
  });

  it('the job scans, then re-checks each item right before acting', async () => {
    const session = (name: string, idleDays = 3): CleanupSession => ({
      id: name, target: 'repo', branch: `feat/${name}`, isGroup: false, paths: [wt[name]], archivedAt: null, lastActiveMs: Date.now() - idleDays * DAY, aliases: ['repo'],
    });
    const acted: Array<[string, CleanupAction]> = [];
    const job = createCleanupJob({
      sessions: () => [session('merged'), session('squashed'), session('work'), session('dirty'), session('fresh', 0)],
      baseCheckouts: () => [main],
      fetchRepos: () => [{ alias: 'repo', path: main }],
      fetch: async () => {},
      run: defaultRunner,
      act: async (s, a) => void acted.push([s.id, a]),
    });
    job.scan();
    await job.idle();
    const st = job.state();
    expect(st.phase).toBe('idle');
    expect(st.done).toBe(5);
    const byId = Object.fromEntries(st.candidates.map((c) => [c.sessionId, c]));
    expect(byId.merged).toMatchObject({ verdict: 'merged', suggested: 'delete' });
    expect(byId.squashed).toMatchObject({ verdict: 'merged', suggested: 'delete' });
    expect(byId.work).toMatchObject({ verdict: 'work', suggested: null });
    expect(byId.dirty).toMatchObject({ verdict: 'dirty', suggested: null });
    expect(byId.fresh).toBeUndefined(); // used today: not a candidate

    // Between the scan and the click, a file appears in the "merged" one.
    fs.writeFileSync(path.join(wt.merged, 'late.txt'), 'x\n');
    expect(job.apply([{ sessionId: 'merged', action: 'delete' }, { sessionId: 'squashed', action: 'delete' }])).toBe(true);
    await job.idle();
    expect(acted).toEqual([['squashed', 'delete']]);
    expect(job.state().results).toEqual([
      { sessionId: 'merged', action: 'delete', ok: false, message: 'Not removed: 1 uncommitted file.' },
      { sessionId: 'squashed', action: 'delete', ok: true, message: 'Worktree removed' },
    ]);
    expect(job.state().candidates.map((c) => c.sessionId)).not.toContain('squashed');
    fs.rmSync(path.join(wt.merged, 'late.txt'));
  }, 120_000);
});
