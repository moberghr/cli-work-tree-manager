import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git, parseWorktreeList, isGitRepo, getCurrentBranch, localBranchExists, isBranchMerged } from '../../src/core/git.js';

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

describe('isBranchMerged', () => {
  it('returns true when branch is ancestor of main', () => {
    initRepo();
    // Create a feature branch from main, then merge it
    git(['checkout', '-b', 'feature/done'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'feat.txt'), 'feature');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'feature work', '--no-gpg-sign'], tmpDir);
    git(['checkout', 'main'], tmpDir);
    git(['merge', 'feature/done', '--no-gpg-sign'], tmpDir);

    expect(isBranchMerged('feature/done', tmpDir)).toBe(true);
  });

  it('returns false when branch is not merged', () => {
    initRepo();
    git(['checkout', '-b', 'feature/wip'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'wip.txt'), 'wip');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'wip', '--no-gpg-sign'], tmpDir);

    expect(isBranchMerged('feature/wip', tmpDir)).toBe(false);
  });

  it('uses explicit baseBranch when provided', () => {
    initRepo();
    git(['checkout', '-b', 'develop'], tmpDir);
    git(['checkout', '-b', 'feature/x'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'x');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'x', '--no-gpg-sign'], tmpDir);
    git(['checkout', 'develop'], tmpDir);
    git(['merge', 'feature/x', '--no-gpg-sign'], tmpDir);

    // Not merged into main
    expect(isBranchMerged('feature/x', tmpDir)).toBe(false);
    // But merged into develop
    expect(isBranchMerged('feature/x', tmpDir, 'develop')).toBe(true);
  });

  it('falls back to master when main does not exist', () => {
    // Create repo with master as default branch
    const repoDir = tmpDir;
    git(['init', '-b', 'master'], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);

    git(['checkout', '-b', 'feature/y'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'y.txt'), 'y');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'y', '--no-gpg-sign'], repoDir);
    git(['checkout', 'master'], repoDir);
    git(['merge', 'feature/y', '--no-gpg-sign'], repoDir);

    expect(isBranchMerged('feature/y', repoDir)).toBe(true);
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
