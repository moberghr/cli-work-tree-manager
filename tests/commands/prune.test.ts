import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { pruneCommand } from '../../src/commands/prune.js';

let homeDir: string;
let projectDir: string;
let repoDir: string;
let wtDir: string;

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

// `work prune --force` skips the interactive picker, so the handler removes
// every collected worktree without an inquirer round-trip.
function runPrune(extra: Record<string, unknown> = {}): Promise<void> {
  const argv = { _: ['prune'], force: true, ...extra };
  return (pruneCommand.handler as Function)(argv);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-prune-home-'));
  // realpath: git reports resolved worktree paths; /tmp is a symlink on macOS.
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-prune-proj-')));
  wtDir = path.join(projectDir, 'worktrees');

  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  initRepo();

  const config: WorkConfig = {
    worktreesRoot: wtDir,
    repos: { repo: repoDir },
    groups: {},
    copyFiles: [],
  };
  saveConfig(config);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('work prune squash-merge', () => {
  it('surfaces and removes a squash-merged worktree (includeSquash for the human flow)', async () => {
    // Create a feature worktree, commit, then squash-merge into main. A squash
    // merge leaves no merge-commit linkage, so it only matches the lower-
    // confidence squash heuristic — which `work sync` gates out by default but
    // interactive `work prune` must still offer (the user confirms the list).
    const wtPath = path.join(wtDir, 'feature-sq');
    createSingleWorktree(repoDir, wtPath, 'feature/sq', config());
    fs.writeFileSync(path.join(wtPath, 'sq.txt'), 'sq');
    git(['add', '.'], wtPath);
    git(['commit', '-m', 'add sq', '--no-gpg-sign'], wtPath);

    git(['merge', '--squash', 'feature/sq'], repoDir);
    git(['commit', '-m', 'squash feature/sq', '--no-gpg-sign'], repoDir);

    expect(fs.existsSync(wtPath)).toBe(true);

    await runPrune();

    // The squash-merged worktree must have been surfaced and removed.
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

// Helper to rebuild the config object (saved config is read from disk by the
// command, but createSingleWorktree needs it in-process).
function config(): WorkConfig {
  return {
    worktreesRoot: wtDir,
    repos: { repo: repoDir },
    groups: {},
    copyFiles: [],
  };
}
