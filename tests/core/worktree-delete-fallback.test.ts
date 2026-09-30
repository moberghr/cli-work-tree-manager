import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkConfig } from '../../src/core/config.js';

// git behaves as it did on the user's machine for some worktrees: it passes
// its checks, then stops half way through deleting. Everything else is real.
const failRemove = vi.hoisted(() => ({ stderr: '' }));
vi.mock('../../src/core/git.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/git.js')>();
  return {
    ...real,
    git: (args: string[], cwd: string) =>
      failRemove.stderr && args.includes('worktree') && args.includes('remove')
        ? { stdout: '', stderr: failRemove.stderr, exitCode: 1 }
        : real.git(args, cwd),
  };
});

import { git } from '../../src/core/git.js';
import { createSingleWorktree, isDeleteFailure, removeSingleWorktree } from '../../src/core/worktree.js';

const config: WorkConfig = { worktreesRoot: '', repos: {}, groups: {}, copyFiles: [] };
let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fallback-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  failRemove.stderr = '';
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('removing a worktree git fails to delete', () => {
  it('finishes the delete itself and prunes the registration', () => {
    const wt = path.join(tmp, 'wt');
    createSingleWorktree(repo, wt, 'feature/x', config);
    failRemove.stderr = `error: failed to delete '${wt}': Filename too long`;
    expect(removeSingleWorktree(repo, wt, 'feature/x', false)).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    failRemove.stderr = '';
    const registered = git(['worktree', 'list', '--porcelain'], repo).stdout.split('\n').filter((l) => l.startsWith('worktree '));
    expect(registered).toHaveLength(1); // only the main checkout is left
  });

  it('still refuses when git refuses (uncommitted work is not deleted)', () => {
    const wt = path.join(tmp, 'wt2');
    createSingleWorktree(repo, wt, 'feature/y', config);
    failRemove.stderr = `fatal: '${wt}' contains modified or untracked files, use --force to delete it`;
    expect(removeSingleWorktree(repo, wt, 'feature/y', true)).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('tells a delete failure from a refusal', () => {
    expect(isDeleteFailure("error: failed to delete 'C:/wt/x': Invalid argument")).toBe(true);
    expect(isDeleteFailure("fatal: 'C:/wt/x' is locked; use 'unlock' to override")).toBe(false);
  });
});
