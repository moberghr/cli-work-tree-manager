import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git, parseWorktreeList, getCurrentBranch, localBranchExists } from '../../src/core/git.js';
import { createSingleWorktree, removeSingleWorktree } from '../../src/core/worktree.js';
import type { WorkConfig } from '../../src/core/config.js';

let tmpDir: string;
let repoDir: string;
let wtDir: string;

const config: WorkConfig = {
  worktreesRoot: '',
  repos: {},
  groups: {},
  copyFiles: [],
};

function initRepo(): string {
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);
  return repoDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-wt-test-'));
  wtDir = path.join(tmpDir, 'worktrees');
  config.worktreesRoot = wtDir;
  initRepo();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSingleWorktree', () => {
  it('creates a new worktree for a new branch', () => {
    const wtPath = path.join(wtDir, 'feature-test');
    const result = createSingleWorktree(repoDir, wtPath, 'feature/test', config);

    expect(result).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(getCurrentBranch(wtPath)).toBe('feature/test');
  });

  it('is idempotent — succeeds if worktree already exists', () => {
    const wtPath = path.join(wtDir, 'feature-test');
    createSingleWorktree(repoDir, wtPath, 'feature/test', config);
    const result = createSingleWorktree(repoDir, wtPath, 'feature/test', config);

    expect(result).toBe(true);
  });

  it('fails if branch is checked out in another worktree', () => {
    const wt1 = path.join(wtDir, 'wt1');
    const wt2 = path.join(wtDir, 'wt2');
    createSingleWorktree(repoDir, wt1, 'feature/test', config);
    const result = createSingleWorktree(repoDir, wt2, 'feature/test', config);

    expect(result).toBe(false);
    expect(fs.existsSync(wt2)).toBe(false);
  });

  it('copies files matching copyFiles patterns', () => {
    // Create a file that matches the pattern
    fs.writeFileSync(path.join(repoDir, 'appsettings.Development.json'), '{}');

    const configWithCopy: WorkConfig = {
      ...config,
      copyFiles: ['*.Development.json'],
    };

    const wtPath = path.join(wtDir, 'feature-copy');
    createSingleWorktree(repoDir, wtPath, 'feature/copy', configWithCopy);

    expect(fs.existsSync(path.join(wtPath, 'appsettings.Development.json'))).toBe(true);
  });

  describe('with baseBranch', () => {
    it('creates new branch from a base branch', () => {
      // Create a base branch with a unique commit
      git(['checkout', '-b', 'base-branch'], repoDir);
      fs.writeFileSync(path.join(repoDir, 'base-file.txt'), 'from base');
      git(['add', '.'], repoDir);
      git(['commit', '-m', 'base commit', '--no-gpg-sign'], repoDir);
      git(['checkout', 'main'], repoDir);

      const wtPath = path.join(wtDir, 'feature-from-base');
      const result = createSingleWorktree(repoDir, wtPath, 'feature/from-base', config, 'base-branch');

      expect(result).toBe(true);
      expect(fs.existsSync(wtPath)).toBe(true);
      expect(getCurrentBranch(wtPath)).toBe('feature/from-base');
      // The new branch should have the file from the base branch
      expect(fs.existsSync(path.join(wtPath, 'base-file.txt'))).toBe(true);
    });

    it('fails when target branch already exists locally', () => {
      // Create the target branch first
      git(['checkout', '-b', 'existing-branch'], repoDir);
      git(['checkout', 'main'], repoDir);

      const wtPath = path.join(wtDir, 'existing-branch');
      const result = createSingleWorktree(repoDir, wtPath, 'existing-branch', config, 'main');

      expect(result).toBe(false);
      expect(fs.existsSync(wtPath)).toBe(false);
    });

    it('fails when base branch does not exist', () => {
      const wtPath = path.join(wtDir, 'feature-no-base');
      const result = createSingleWorktree(repoDir, wtPath, 'feature/no-base', config, 'nonexistent-branch');

      expect(result).toBe(false);
      expect(fs.existsSync(wtPath)).toBe(false);
    });

    it('without baseBranch still creates from HEAD (regression)', () => {
      const wtPath = path.join(wtDir, 'feature-no-base-arg');
      const result = createSingleWorktree(repoDir, wtPath, 'feature/no-base-arg', config);

      expect(result).toBe(true);
      expect(getCurrentBranch(wtPath)).toBe('feature/no-base-arg');
    });
  });
});

describe('removeSingleWorktree', () => {
  it('removes an existing worktree', () => {
    const wtPath = path.join(wtDir, 'feature-rm');
    createSingleWorktree(repoDir, wtPath, 'feature/rm', config);

    const result = removeSingleWorktree(repoDir, wtPath, 'feature/rm', false);
    expect(result).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('succeeds when worktree does not exist', () => {
    const result = removeSingleWorktree(repoDir, '/nonexistent/path', 'x', false);
    expect(result).toBe(true);
  });

  it('blocks removal when there are uncommitted changes', () => {
    const wtPath = path.join(wtDir, 'feature-dirty');
    createSingleWorktree(repoDir, wtPath, 'feature/dirty', config);

    // Create uncommitted file
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'uncommitted');

    const result = removeSingleWorktree(repoDir, wtPath, 'feature/dirty', false);
    expect(result).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it('force removes even with uncommitted changes', () => {
    const wtPath = path.join(wtDir, 'feature-force');
    createSingleWorktree(repoDir, wtPath, 'feature/force', config);

    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'uncommitted');

    const result = removeSingleWorktree(repoDir, wtPath, 'feature/force', true);
    expect(result).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});
