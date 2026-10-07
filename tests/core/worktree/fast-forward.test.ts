import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { createSingleWorktree, fastForwardBranch, freshestRef } from '../../../src/core/worktree/worktree.js';

/**
 * Creating a worktree for a branch that exists locally used to check it out
 * in your main checkout, pull, and check the old branch back out — ~10 s a
 * repo on a big one, and your checkout switched under you. Now the branch's
 * ref is fast-forwarded to origin's copy; nothing is checked out. And a new
 * branch from `--base` starts from the base's freshest copy.
 *
 * The repos (an upstream on main + feat/x, and a clone) are built once and
 * copied for each test (testing.md §4.7).
 */
let fixture: string;
let home: string;
let upstream: string;
let repo: string;
const sha = (ref: string, dir = repo) => git(['rev-parse', ref], dir).stdout;
function commitIn(dir: string, file: string, msg: string) {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', msg, '--no-gpg-sign'], dir);
}
const config = () => ({ worktreesRoot: path.join(home, 'worktrees'), repos: {} }) as never;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-fixture-'));
  const up = path.join(fixture, 'upstream');
  fs.mkdirSync(up);
  git(['init', '-q', '-b', 'main'], up);
  git(['config', 'user.email', 't@t.t'], up);
  git(['config', 'user.name', 'Test'], up);
  commitIn(up, 'base.txt', 'base');
  git(['branch', 'feat/x'], up);
  const clone = path.join(fixture, 'repo');
  git(['clone', '-q', up, clone], fixture);
  git(['config', 'user.email', 't@t.t'], clone);
  git(['config', 'user.name', 'Test'], clone);
  git(['branch', '--track', 'feat/x', 'origin/feat/x'], clone);
});
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.cpSync(fixture, home, { recursive: true });
  upstream = path.join(home, 'upstream');
  repo = path.join(home, 'repo');
  git(['remote', 'set-url', 'origin', upstream], repo);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('fastForwardBranch', () => {
  it("moves a branch that is behind origin's copy, and leaves the main checkout where it is", () => {
    git(['checkout', '-q', 'feat/x'], upstream);
    commitIn(upstream, 'new.txt', 'someone pushed');
    git(['fetch', '-q'], repo);
    expect(fastForwardBranch(repo, 'feat/x')).toBe('forwarded');
    expect(sha('feat/x')).toBe(sha('origin/feat/x'));
    expect(git(['branch', '--show-current'], repo).stdout).toBe('main');
    expect(fastForwardBranch(repo, 'feat/x')).toBe('current');
  });

  it("follows origin/<branch>, not @{upstream}: a branch tracking its base (origin/main) isn't moved to main", () => {
    git(['branch', '--track', 'feat/y', 'origin/main'], repo);
    commitIn(upstream, 'main-moves.txt', 'main moves on');
    git(['fetch', '-q'], repo);
    const before = sha('feat/y');
    expect(fastForwardBranch(repo, 'feat/y')).toBe('none'); // never pushed: nothing to follow
    expect(sha('feat/y')).toBe(before);
  });

  it('a branch with commits origin lacks is left alone, with a warning', () => {
    git(['checkout', '-q', 'feat/x'], repo);
    commitIn(repo, 'mine.txt', 'mine, not pushed');
    git(['checkout', '-q', 'main'], repo);
    git(['checkout', '-q', 'feat/x'], upstream);
    commitIn(upstream, 'theirs.txt', 'theirs');
    git(['fetch', '-q'], repo);
    const before = sha('feat/x');
    expect(fastForwardBranch(repo, 'feat/x')).toBe('diverged');
    expect(sha('feat/x')).toBe(before);
  });
});

describe('freshestRef (where a new branch from --base starts)', () => {
  it("origin's copy when the local one is behind; the local one when it has its own commits", () => {
    commitIn(upstream, 'up.txt', 'main moves on');
    git(['fetch', '-q'], repo);
    expect(freshestRef(repo, 'main')).toBe('origin/main');
    commitIn(repo, 'local.txt', 'local work on main');
    expect(freshestRef(repo, 'main')).toBe('main');
    expect(freshestRef(repo, 'nope')).toBeNull();
  });
});

describe('createSingleWorktree', () => {
  it("an existing local branch: origin's latest, without switching the main checkout (nor pulling it)", () => {
    git(['checkout', '-q', 'feat/x'], upstream);
    commitIn(upstream, 'new.txt', 'someone pushed');
    const mainBefore = sha('main');
    const wt = path.join(home, 'worktrees', 'feat-x');
    expect(createSingleWorktree(repo, wt, 'feat/x', config())).toBe(true);
    expect(sha('HEAD', wt)).toBe(sha('origin/feat/x'));
    expect(git(['branch', '--show-current'], repo).stdout).toBe('main');
    expect(sha('main')).toBe(mainBefore);
  });

  it('a new branch from the main checkout: it is pulled first, so the branch starts from origin', () => {
    commitIn(upstream, 'up.txt', 'main moves on');
    const wt = path.join(home, 'worktrees', 'feat-new');
    expect(createSingleWorktree(repo, wt, 'feat/new', config())).toBe(true);
    expect(sha('main')).toBe(sha('origin/main'));
    expect(sha('HEAD', wt)).toBe(sha('origin/main'));
  });

  it("--base a branch that isn't checked out (nothing pulls it): the new branch starts from origin's copy, not the stale local one", () => {
    git(['checkout', '-q', '-b', 'other'], repo); // main is no longer checked out
    commitIn(upstream, 'up.txt', 'main moves on');
    const stale = sha('main');
    const wt = path.join(home, 'worktrees', 'feat-based');
    expect(createSingleWorktree(repo, wt, 'feat/based', config(), 'main')).toBe(true);
    expect(sha('HEAD', wt)).toBe(sha('origin/main'));
    expect(sha('HEAD', wt)).not.toBe(stale);
  });
});
