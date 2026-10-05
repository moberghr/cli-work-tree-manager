import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteMergedBranches, findMergedBranches, type BranchTidyDeps } from '../../../src/core/cleanup/branch-tidy.js';
import { defaultRunner, type CommandRunner } from '../../../src/core/pr/ship.js';
import { sessionBranchUse } from '../../../src/core/cleanup/branch-tidy-deps.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function commit(repo: string, file: string) {
  fs.writeFileSync(path.join(repo, file), file);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', file);
}

/**
 * origin (bare) + a clone with one branch per case:
 *   feat/merged        merged into main and pushed      → offered (merged)
 *   feat/squashed      upstream deleted, PR head = tip  → offered (squash-merged #7)
 *   feat/squash-moved  upstream deleted, PR head ≠ tip  → not offered (work after the PR)
 *   feat/wip           unmerged                         → not offered
 *   feat/checked-out   merged, but checked out          → not offered
 *   develop            merged, long-lived name          → not offered
 *   feat/live          merged, a current session's      → not offered
 *   feat/archived      merged, an archived session's    → offered with the session
 */
function buildFixture(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  commit(repo, 'a');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');

  git(repo, 'checkout', '-q', '-b', 'feat/merged');
  commit(repo, 'b');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/merged');
  git(repo, 'push', '-q', 'origin', 'main');

  const tips: Record<string, string> = {};
  for (const b of ['feat/squashed', 'feat/squash-moved']) {
    git(repo, 'checkout', '-q', '-b', b, 'main');
    commit(repo, b.replace('/', '-'));
    git(repo, 'push', '-q', '-u', 'origin', b);
    tips[b] = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', '-q', 'origin', '--delete', b);
  }
  commit(repo, 'after-the-pr'); // feat/squash-moved moved on after its PR
  git(repo, 'checkout', '-q', '-b', 'feat/wip', 'main');
  commit(repo, 'wip');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'fetch', '-q', '--prune');
  for (const b of ['feat/checked-out', 'develop', 'feat/live', 'feat/archived']) git(repo, 'branch', b, 'main');
  git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'), 'feat/checked-out');
  return { repo, tips };
}

function depsFor(repo: string, tips: Record<string, string>, gh: string[][]): BranchTidyDeps {
  const run: CommandRunner = async (cmd, args, cwd) => {
    if (cmd !== 'gh') return defaultRunner(cmd, args, cwd);
    gh.push(args);
    const head = args[args.indexOf('--head') + 1];
    const prs =
      head === 'feat/squashed'
        ? [{ number: 7, headRefOid: tips['feat/squashed'] }]
        : head === 'feat/squash-moved'
          ? [{ number: 8, headRefOid: tips['feat/squash-moved'] }]
          : [];
    return { code: 0, stdout: JSON.stringify(prs), stderr: '' };
  };
  return {
    repos: () => [{ alias: 'api', path: repo }],
    sessionBranches: () =>
      new Map([
        [
          'api',
          new Map([
            ['feat/live', { id: 'live1', archived: false }],
            ['feat/archived', { id: 'arch1', archived: true }],
          ]),
        ],
      ]),
    run,
  };
}

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-tidy-'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('findMergedBranches', () => {
  it('offers only branches whose work is certainly in main', async () => {
    const { repo, tips } = buildFixture(path.join(root, 'find'));
    const gh: string[][] = [];
    const out = await findMergedBranches(depsFor(repo, tips, gh));
    const byName = Object.fromEntries(out.map((b) => [b.branch, b]));
    expect(Object.keys(byName).sort()).toEqual(['feat/archived', 'feat/merged', 'feat/squashed']);
    expect(byName['feat/merged']).toMatchObject({ repo: 'api', reason: 'merged' });
    expect(byName['feat/squashed']).toMatchObject({ reason: 'squash-merged', prNumber: 7, tip: tips['feat/squashed'] });
    expect(byName['feat/archived']).toMatchObject({ reason: 'merged', archivedSession: 'arch1' });
    // gh is asked only about branches whose upstream is gone
    expect(gh.map((a) => a[a.indexOf('--head') + 1]).sort()).toEqual(['feat/squash-moved', 'feat/squashed']);
  }, 60_000);
});

describe('deleteMergedBranches', () => {
  it('deletes what is still certain, and refuses a branch that moved since the scan', async () => {
    const { repo, tips } = buildFixture(path.join(root, 'delete'));
    const deps = depsFor(repo, tips, []);
    // After the scan, feat/squashed gets a new commit: no longer the PR's head.
    git(repo, 'checkout', '-q', 'feat/squashed');
    commit(repo, 'later');
    git(repo, 'checkout', '-q', 'main');
    const results = await deleteMergedBranches(
      [
        { repo: 'api', branch: 'feat/merged' },
        { repo: 'api', branch: 'feat/squashed' },
        { repo: 'api', branch: 'feat/wip' },
        { repo: 'api', branch: 'feat/live' },
      ],
      deps,
    );
    expect(results.map((r) => [r.branch, r.ok])).toEqual([
      ['feat/merged', true],
      ['feat/squashed', false],
      ['feat/wip', false],
      ['feat/live', false],
    ]);
    const left = git(repo, 'branch', '--format=%(refname:short)').split('\n');
    expect(left).not.toContain('feat/merged');
    expect(left).toEqual(expect.arrayContaining(['feat/squashed', 'feat/wip', 'feat/live', 'main']));
  }, 60_000);

  it('refuses a branch whose tip is not the one you were shown, and re-checks only the chosen ones', async () => {
    const { repo, tips } = buildFixture(path.join(root, 'tip'));
    const gh: string[][] = [];
    const deps = depsFor(repo, tips, gh);
    const results = await deleteMergedBranches(
      [
        { repo: 'api', branch: 'feat/merged', tip: 'f'.repeat(40) },
        { repo: 'api', branch: 'feat/archived', tip: git(repo, 'rev-parse', 'feat/archived') },
      ],
      deps,
    );
    expect(results.map((r) => [r.branch, r.ok, r.message])).toEqual([
      ['feat/merged', false, 'Not deleted: it has moved since you looked.'],
      ['feat/archived', true, expect.stringContaining('Deleted')],
    ]);
    expect(gh).toEqual([]); // no gh for branches nobody chose
  }, 60_000);
});

describe('sessionBranchUse', () => {
  const sess = (target: string, isGroup: boolean, archived: boolean): WorktreeSession => ({
    target,
    branch: 'feat/x',
    isGroup,
    paths: [],
    createdAt: '',
    lastAccessedAt: '',
    ...(archived ? { archivedAt: '2026-09-01T00:00:00Z' } : {}),
  });
  it('a current session using a branch wins over an archived one on the same repo + branch, in either order', () => {
    const groups = { shop: ['api', 'web'] };
    for (const list of [
      [sess('shop', true, false), sess('api', false, true)],
      [sess('api', false, true), sess('shop', true, false)],
    ]) {
      const use = sessionBranchUse(list, groups);
      expect(use.get('api')?.get('feat/x')).toMatchObject({ archived: false, id: sessionIdFor(list.find((s) => s.isGroup)!) });
      expect(use.get('web')?.get('feat/x')?.archived).toBe(false);
    }
    expect(
      sessionBranchUse([sess('api', false, true)], groups)
        .get('api')
        ?.get('feat/x')?.archived,
    ).toBe(true);
  });
});
