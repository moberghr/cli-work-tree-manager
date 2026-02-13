import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git, parseWorktreeList, isGitRepo, getCurrentBranch, localBranchExists } from '../../src/core/git.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-git-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function initRepo(dir?: string): string {
  const repoDir = dir ?? tmpDir;
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  // Create initial commit so branches work
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);
  return repoDir;
}

describe('git', () => {
  it('runs a git command and returns output', () => {
    initRepo();
    const result = git(['status', '--porcelain'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns non-zero exit code for invalid command', () => {
    const result = git(['not-a-command'], tmpDir);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('isGitRepo', () => {
  it('returns true for a git repository', () => {
    initRepo();
    expect(isGitRepo(tmpDir)).toBe(true);
  });

  it('returns false for a non-git directory', () => {
    expect(isGitRepo(tmpDir)).toBe(false);
  });
});

describe('getCurrentBranch', () => {
  it('returns current branch name', () => {
    initRepo();
    expect(getCurrentBranch(tmpDir)).toBe('main');
  });

  it('returns empty string for non-git directory', () => {
    expect(getCurrentBranch(tmpDir)).toBe('');
  });
});

describe('localBranchExists', () => {
  it('returns true for existing branch', () => {
    initRepo();
    expect(localBranchExists('main', tmpDir)).toBe(true);
  });

  it('returns false for non-existing branch', () => {
    initRepo();
    expect(localBranchExists('nonexistent', tmpDir)).toBe(false);
  });
});

describe('parseWorktreeList', () => {
  it('parses main worktree from a repo', () => {
    initRepo();
    const entries = parseWorktreeList(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].branch).toBe('main');
    expect(entries[0].path).toBeTruthy();
  });

  it('returns empty for non-git directory', () => {
    expect(parseWorktreeList(tmpDir)).toEqual([]);
  });

  it('includes additional worktrees', () => {
    initRepo();
    const wtPath = path.join(tmpDir, 'wt-feature');
    git(['worktree', 'add', wtPath, '-b', 'feature/test'], tmpDir);

    const entries = parseWorktreeList(tmpDir);
    expect(entries.length).toBe(2);

    const feature = entries.find((e) => e.branch === 'feature/test');
    expect(feature).toBeDefined();
    // On Windows, temp dirs use short paths (DOMAGO~1) but git resolves to long paths.
    // Just check the path ends with the expected directory name.
    expect(feature!.path.replace(/\\/g, '/')).toContain('wt-feature');
  });
});
