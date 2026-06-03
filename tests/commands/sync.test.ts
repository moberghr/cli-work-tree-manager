import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { syncCommand } from '../../src/commands/sync.js';

// Controllable wrapper around the real removeSingleWorktree so individual
// tests can force a non-throwing failure (returns false) for a chosen path.
const failingPaths = new Set<string>();
// Normalise slash direction + case + Windows 8.3 short-name expansion.
// The test stores `wtPath` as the path it constructed (potentially with
// `DOMAGO~1`-style short segments if TEMP is set that way), but git emits
// the canonical long-name form with forward slashes from `worktree list`.
// `realpathSync.native` is the only Node API that expands 8.3 on Windows.
function canonPath(p: string): string {
  try {
    return fs.realpathSync.native(p).replace(/\\/g, '/').toLowerCase();
  } catch {
    return p.replace(/\\/g, '/').toLowerCase();
  }
}
vi.mock('../../src/core/worktree.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/worktree.js')>(
    '../../src/core/worktree.js',
  );
  return {
    ...actual,
    removeSingleWorktree: (
      repoPath: string,
      worktreePath: string,
      branchName: string,
      force: boolean,
    ): boolean => {
      const incoming = canonPath(worktreePath);
      for (const p of failingPaths) {
        if (canonPath(p) === incoming) return false;
      }
      return actual.removeSingleWorktree(repoPath, worktreePath, branchName, force);
    },
  };
});

let homeDir: string;
let projectDir: string;
let repoDir: string;
let wtDir: string;
let wtPath: string;

function initRepo(): void {
  repoDir = path.join(projectDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);
}

function runSync(extra: Record<string, unknown> = {}): Promise<void> {
  const argv = { _: ['sync'], dryRun: false, force: true, ...extra };
  return (syncCommand.handler as Function)(argv);
}

beforeEach(() => {
  // Separate dirs for the fake home (config lives here) and the project repo.
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-sync-home-'));
  // realpath: git reports resolved worktree paths; /tmp is a symlink on macOS.
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-sync-proj-')));
  wtDir = path.join(projectDir, 'worktrees');

  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  failingPaths.clear();

  initRepo();

  const config: WorkConfig = {
    worktreesRoot: wtDir,
    repos: { repo: repoDir },
    groups: {},
    copyFiles: [],
  };
  saveConfig(config);

  // Create a feature worktree and merge its branch into main so it's prunable.
  wtPath = path.join(wtDir, 'feature-z');
  createSingleWorktree(repoDir, wtPath, 'feature/z', config);
  fs.writeFileSync(path.join(wtPath, 'feat.txt'), 'feat');
  git(['add', '.'], wtPath);
  git(['commit', '-m', 'add feat', '--no-gpg-sign'], wtPath);
  git(['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge feature/z', 'feature/z'], repoDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('work sync --dry-run', () => {
  it('removes nothing in dry-run mode', async () => {
    expect(fs.existsSync(wtPath)).toBe(true);

    await runSync({ dryRun: true });

    // Worktree must still be on disk.
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('work sync', () => {
  it('removes a merged worktree when not in dry-run', async () => {
    expect(fs.existsSync(wtPath)).toBe(true);

    await runSync();

    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('work sync dirty-tree safety', () => {
  it('refuses to remove a merged-but-dirty worktree without --force', async () => {
    // Make the merged worktree dirty.
    fs.writeFileSync(path.join(wtPath, 'feat.txt'), 'local edit');
    expect(git(['status', '--porcelain'], wtPath).stdout).not.toBe('');

    await runSync({ force: false });

    // Worktree must survive; sync must not fail the process for a safe skip.
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('removes a merged-but-dirty worktree when --force is passed', async () => {
    fs.writeFileSync(path.join(wtPath, 'feat.txt'), 'local edit');

    await runSync({ force: true });

    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('work sync partial failure', () => {
  it('sets exitCode=1 when a removal returns false (non-throwing)', async () => {
    // The single merged worktree is clean, but removeSingleWorktree is forced
    // to report a non-throwing failure for it.
    failingPaths.add(wtPath);

    await runSync({ force: true });

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('work sync group worktrees', () => {
  it('removes a fully-merged group worktree', async () => {
    // Second repo for the group.
    const repoBDir = path.join(projectDir, 'repoB');
    fs.mkdirSync(repoBDir, { recursive: true });
    git(['init', '-b', 'main'], repoBDir);
    git(['config', 'user.email', 'test@test.com'], repoBDir);
    git(['config', 'user.name', 'Test'], repoBDir);
    fs.writeFileSync(path.join(repoBDir, 'README.md'), '# b');
    git(['add', '.'], repoBDir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repoBDir);

    const config: WorkConfig = {
      worktreesRoot: wtDir,
      repos: { repo: repoDir, repoB: repoBDir },
      groups: { grp: ['repo', 'repoB'] },
      copyFiles: [],
    };
    saveConfig(config);

    // Group layout: <wtDir>/<group>/<branchDir>/<repoName>
    const branchDirPath = path.join(wtDir, 'grp', 'feature-g');
    const wtA = path.join(branchDirPath, path.basename(repoDir));
    const wtB = path.join(branchDirPath, path.basename(repoBDir));
    createSingleWorktree(repoDir, wtA, 'feature/g', config);
    createSingleWorktree(repoBDir, wtB, 'feature/g', config);

    // Add a commit on each sub-repo branch and merge into each repo's main.
    fs.writeFileSync(path.join(wtA, 'ga.txt'), 'ga');
    git(['add', '.'], wtA);
    git(['commit', '-m', 'ga', '--no-gpg-sign'], wtA);
    git(['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge g', 'feature/g'], repoDir);

    fs.writeFileSync(path.join(wtB, 'gb.txt'), 'gb');
    git(['add', '.'], wtB);
    git(['commit', '-m', 'gb', '--no-gpg-sign'], wtB);
    git(['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge g', 'feature/g'], repoBDir);

    expect(fs.existsSync(wtA)).toBe(true);
    expect(fs.existsSync(wtB)).toBe(true);

    await runSync({ force: true });

    expect(fs.existsSync(wtA)).toBe(false);
    expect(fs.existsSync(wtB)).toBe(false);
  });
});
