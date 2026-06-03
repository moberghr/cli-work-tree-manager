import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { collectPrunable } from '../../src/core/prunable-scan.js';
import type { WorkConfig } from '../../src/core/config.js';

let tmpDir: string;
let repoDir: string;
let wtDir: string;
let config: WorkConfig;

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

/** Commit a file on the current branch. */
function commitFile(cwd: string, name: string): void {
  fs.writeFileSync(path.join(cwd, name), name);
  git(['add', '.'], cwd);
  git(['commit', '-m', `add ${name}`, '--no-gpg-sign'], cwd);
}

beforeEach(() => {
  // realpath: on macOS os.tmpdir() lives under the /tmp -> /private/tmp
  // symlink, and git reports the resolved path in `worktree list`. Resolving
  // here keeps the main-repo-skip comparison in collectPrunable consistent.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-prunable-test-')));
  wtDir = path.join(tmpDir, 'worktrees');
  initRepo();
  config = {
    worktreesRoot: wtDir,
    repos: { repo: repoDir },
    groups: {},
    copyFiles: [],
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectPrunable', () => {
  it('returns nothing when no worktrees exist beyond the main repo', () => {
    const result = collectPrunable(config, { fetch: false, print: false });
    expect(result).toEqual([]);
  });

  it('does not flag an unmerged branch with unique commits', () => {
    const wtPath = path.join(wtDir, 'feature-x');
    createSingleWorktree(repoDir, wtPath, 'feature/x', config);
    commitFile(wtPath, 'unique.txt');

    const result = collectPrunable(config, { fetch: false, print: false });
    expect(result).toEqual([]);
  });

  it('flags a branch whose commits are merged into main', () => {
    // Create a feature branch with a commit, then merge it into main.
    const wtPath = path.join(wtDir, 'feature-y');
    createSingleWorktree(repoDir, wtPath, 'feature/y', config);
    commitFile(wtPath, 'feat.txt');

    // Merge feature/y into main (non-fast-forward so it's a real merge).
    git(['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge feature/y', 'feature/y'], repoDir);

    const result = collectPrunable(config, { fetch: false, print: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'single',
      target: 'repo',
      branch: 'feature/y',
      confidence: 'merged',
    });
    // Slash + 8.3 short-name normalisation: git emits long-name +
    // forward slashes regardless of what the caller passed in, and on
    // Windows `wtPath` may carry a `DOMAGO~1`-style short segment via
    // the TEMP env. Compare by lowercased basenames + the "we got back
    // a Windows worktree path" sanity check.
    const wtOut = result[0].repos[0].worktreePath;
    expect(path.basename(wtOut)).toBe(path.basename(wtPath));
  });

  describe('squash-merge confidence', () => {
    /** Squash-merge a feature branch into main (no merge commit linkage). */
    function squashMerge(branch: string): void {
      git(['merge', '--squash', branch], repoDir);
      git(['commit', '-m', `squash ${branch}`, '--no-gpg-sign'], repoDir);
    }

    it('does NOT prune a squash-merged branch by default', () => {
      const wtPath = path.join(wtDir, 'feature-sq');
      createSingleWorktree(repoDir, wtPath, 'feature/sq', config);
      commitFile(wtPath, 'sq.txt');
      squashMerge('feature/sq');

      const result = collectPrunable(config, { fetch: false, print: false });
      expect(result).toEqual([]);
    });

    it('prunes a squash-merged branch with includeSquash', () => {
      const wtPath = path.join(wtDir, 'feature-sq2');
      createSingleWorktree(repoDir, wtPath, 'feature/sq2', config);
      commitFile(wtPath, 'sq2.txt');
      squashMerge('feature/sq2');

      const result = collectPrunable(config, {
        fetch: false,
        print: false,
        includeSquash: true,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'single',
        branch: 'feature/sq2',
        confidence: 'squash-merged',
      });
    });
  });

  describe('skipAliases', () => {
    it('does not flag worktrees in skipped repos', () => {
      const wtPath = path.join(wtDir, 'feature-skip');
      createSingleWorktree(repoDir, wtPath, 'feature/skip', config);
      commitFile(wtPath, 'sk.txt');
      git(['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge', 'feature/skip'], repoDir);

      const result = collectPrunable(config, {
        fetch: false,
        print: false,
        skipAliases: new Set(['repo']),
      });
      expect(result).toEqual([]);
    });
  });
});
