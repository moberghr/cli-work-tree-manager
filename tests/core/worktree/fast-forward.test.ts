import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { createSingleWorktree, fastForwardBranch } from '../../../src/core/worktree/worktree.js';

/**
 * Creating a worktree for a branch that exists locally used to check it out
 * in your main checkout, pull, and check the old branch back out — ~10 s a
 * repo on a big one, and your checkout switched under you. Now the branch's
 * ref is fast-forwarded to its upstream; nothing is checked out.
 */
let home: string;
let upstream: string;
let repo: string;
const sha = (ref: string, dir = repo) => git(['rev-parse', ref], dir).stdout;
function commitIn(dir: string, file: string, msg: string) {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', msg, '--no-gpg-sign'], dir);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  upstream = path.join(home, 'upstream');
  fs.mkdirSync(upstream);
  git(['init', '-q', '-b', 'main'], upstream);
  git(['config', 'user.email', 't@t.t'], upstream);
  git(['config', 'user.name', 'Test'], upstream);
  commitIn(upstream, 'base.txt', 'base');
  git(['branch', 'feat/x'], upstream);
  repo = path.join(home, 'repo');
  git(['clone', '-q', upstream, repo], home);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['branch', '--track', 'feat/x', 'origin/feat/x'], repo);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('fastForwardBranch', () => {
  it('moves a branch that is behind its upstream, and leaves the main checkout where it is', () => {
    git(['checkout', '-q', 'feat/x'], upstream);
    commitIn(upstream, 'new.txt', 'someone pushed');
    git(['fetch', '-q'], repo);
    expect(fastForwardBranch(repo, 'feat/x')).toBe('forwarded');
    expect(sha('feat/x')).toBe(sha('origin/feat/x'));
    expect(git(['branch', '--show-current'], repo).stdout).toBe('main');
    expect(fastForwardBranch(repo, 'feat/x')).toBe('current');
  });

  it('a branch with no upstream, or with commits its upstream lacks, is left alone', () => {
    git(['branch', 'local-only'], repo);
    expect(fastForwardBranch(repo, 'local-only')).toBe('none');
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

describe('createSingleWorktree with an existing local branch', () => {
  it("gets the branch's latest without switching the main checkout (nor pulling it)", () => {
    git(['checkout', '-q', 'feat/x'], upstream);
    commitIn(upstream, 'new.txt', 'someone pushed');
    const mainBefore = sha('main');
    const wt = path.join(home, 'worktrees', 'feat-x');
    expect(createSingleWorktree(repo, wt, 'feat/x', { worktreesRoot: path.join(home, 'worktrees'), repos: {} } as never)).toBe(true);
    expect(sha('HEAD', wt)).toBe(sha('origin/feat/x'));
    expect(git(['branch', '--show-current'], repo).stdout).toBe('main');
    // No pull of the main checkout: the branch didn't start from it.
    expect(sha('main')).toBe(mainBefore);
  });
});
