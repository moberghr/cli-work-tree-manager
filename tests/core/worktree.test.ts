import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git, getCurrentBranch, localBranchExists, repoState } from '../../src/core/git.js';
import { createSingleWorktree, removeSingleWorktree, teardownWorktree, wouldRefuseRemoval } from '../../src/core/worktree.js';
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

  it('pulls latest changes when switching into an existing tracked worktree', () => {
    // Set up a bare "origin" the worktree branch can track.
    const originDir = path.join(tmpDir, 'origin.git');
    git(['init', '--bare', '-b', 'main', originDir], tmpDir);
    git(['remote', 'add', 'origin', originDir], repoDir);
    git(['push', '-u', 'origin', 'main'], repoDir);

    // Create a worktree on a branch (forked from main HEAD) and publish it so
    // it has an upstream. At this point feature/pull == main.
    const wtPath = path.join(wtDir, 'feature-pull');
    createSingleWorktree(repoDir, wtPath, 'feature/pull', config);
    git(['push', '-u', 'origin', 'feature/pull'], wtPath);
    const headBefore = git(['rev-parse', 'HEAD'], wtPath).stdout;

    // Land a new commit and advance origin/feature/pull to it. The main repo's
    // main branch (== feature/pull's fork point) fast-forwards the remote ref.
    fs.writeFileSync(path.join(repoDir, 'remote-change.txt'), 'from origin');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'remote commit', '--no-gpg-sign'], repoDir);
    git(['push', 'origin', 'main:feature/pull'], repoDir);

    // Re-running on the existing worktree should fast-forward it to origin.
    const result = createSingleWorktree(repoDir, wtPath, 'feature/pull', config);

    expect(result).toBe(true);
    expect(git(['rev-parse', 'HEAD'], wtPath).stdout).not.toBe(headBefore);
    expect(fs.existsSync(path.join(wtPath, 'remote-change.txt'))).toBe(true);
  });

  it('skips the pull when pull=false', () => {
    const originDir = path.join(tmpDir, 'origin.git');
    git(['init', '--bare', '-b', 'main', originDir], tmpDir);
    git(['remote', 'add', 'origin', originDir], repoDir);
    git(['push', '-u', 'origin', 'main'], repoDir);

    const wtPath = path.join(wtDir, 'feature-nopull');
    createSingleWorktree(repoDir, wtPath, 'feature/nopull', config);
    git(['push', '-u', 'origin', 'feature/nopull'], wtPath);
    const headBefore = git(['rev-parse', 'HEAD'], wtPath).stdout;

    fs.writeFileSync(path.join(repoDir, 'remote-change.txt'), 'from origin');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'remote commit', '--no-gpg-sign'], repoDir);
    git(['push', 'origin', 'main:feature/nopull'], repoDir);

    const result = createSingleWorktree(repoDir, wtPath, 'feature/nopull', config, undefined, false);

    expect(result).toBe(true);
    // Still parked on the old commit — origin moved on without us.
    expect(git(['rev-parse', 'HEAD'], wtPath).stdout).toBe(headBefore);
    expect(fs.existsSync(path.join(wtPath, 'remote-change.txt'))).toBe(false);
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

  it('removes a worktree holding paths longer than Windows allows (deep node_modules)', () => {
    const wtPath = path.join(wtDir, 'feature-deep');
    createSingleWorktree(repoDir, wtPath, 'feature/deep', config);
    fs.writeFileSync(path.join(wtPath, '.gitignore'), 'node_modules/\n');
    git(['add', '.gitignore'], wtPath);
    git(['commit', '-m', 'ignore', '--no-gpg-sign'], wtPath);
    let deep = path.join(wtPath, 'node_modules');
    while (deep.length < 320) deep = path.join(deep, 'a-rather-long-package-name');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'index.js'), '// deep');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(removeSingleWorktree(repoDir, wtPath, 'feature/deep', false)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(git(['worktree', 'list'], repoDir).stdout).not.toContain('feature-deep');
    expect(localBranchExists('feature/deep', repoDir)).toBe(true); // the branch is kept
  });

  it('teardown finds the worktree by its folder after a branch switch inside it', () => {
    const wtPath = path.join(wtDir, 'fix-ui');
    createSingleWorktree(repoDir, wtPath, 'fix/ui', config);
    git(['checkout', '-b', 'fix/push-setup-cancellation'], wtPath); // what the user did in it
    const cfg: WorkConfig = { ...config, repos: { app: repoDir } };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // By branch name alone it can't be found: no worktree has fix/ui checked out.
    expect(teardownWorktree('app', false, 'fix/ui', cfg, true)).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(true);
    // By the session's folder it is.
    expect(teardownWorktree('app', false, 'fix/ui', cfg, true, [wtPath])).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(localBranchExists('fix/push-setup-cancellation', repoDir)).toBe(true);
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

  describe('a worktree git cannot read (its main repo was moved)', () => {
    // The worktree's `.git` file points at the old location, so every git
    // command in it fails — status and "is this a repo" included. That used
    // to read as "not a repo" and the folder was deleted with rm -rf.
    const brokenWorktree = () => {
      const wtPath = path.join(wtDir, 'feature-orphan');
      createSingleWorktree(repoDir, wtPath, 'feature/orphan', config);
      fs.writeFileSync(path.join(wtPath, 'precious.txt'), 'uncommitted work');
      const moved = path.join(tmpDir, 'repo-moved');
      fs.renameSync(repoDir, moved);
      return { wtPath, moved };
    };

    it('is refused without --force, and its work stays', () => {
      const { wtPath, moved } = brokenWorktree();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(removeSingleWorktree(moved, wtPath, 'feature/orphan', false)).toBe(false);
      expect(fs.readFileSync(path.join(wtPath, 'precious.txt'), 'utf-8')).toBe('uncommitted work');
      expect(wouldRefuseRemoval(wtPath, false)).toBe(true);
    });

    it('is removed with --force', () => {
      const { wtPath, moved } = brokenWorktree();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(removeSingleWorktree(moved, wtPath, 'feature/orphan', true)).toBe(true);
      expect(fs.existsSync(wtPath)).toBe(false);
    });

    it('a plain leftover folder (no .git at all) is still just deleted', () => {
      const leftover = path.join(tmpDir, 'leftover');
      fs.mkdirSync(leftover);
      fs.writeFileSync(path.join(leftover, 'x.txt'), 'x');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(repoState(leftover)).toBe('not-a-repo');
      expect(removeSingleWorktree(repoDir, leftover, 'x', false)).toBe(true);
      expect(fs.existsSync(leftover)).toBe(false);
    });
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
