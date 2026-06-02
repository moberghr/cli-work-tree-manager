import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { syncCommand } from '../../src/commands/sync.js';

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
