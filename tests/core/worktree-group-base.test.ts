import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git, getCurrentBranch } from '../../src/core/git.js';
import { setupWorktree } from '../../src/core/worktree.js';
import { parseBaseSpec } from '../../src/core/base-spec.js';
import { loadHistory } from '../../src/core/history.js';
import type { WorkConfig } from '../../src/core/config.js';

let tmpDir: string;
let backendDir: string;
let frontendDir: string;
let config: WorkConfig;

/** Init a repo on `main` with one commit, then add `extraBranch` carrying a
 *  uniquely-named file so we can assert which base a worktree forked from. */
function initRepo(dir: string, extraBranch: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], dir);

  git(['checkout', '-b', extraBranch], dir);
  fs.writeFileSync(path.join(dir, marker), 'base marker');
  git(['add', '.'], dir);
  git(['commit', '-m', `${extraBranch} commit`, '--no-gpg-sign'], dir);
  git(['checkout', 'main'], dir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-grp-base-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

  backendDir = path.join(tmpDir, 'backend');
  frontendDir = path.join(tmpDir, 'frontend');
  initRepo(backendDir, 'dev', 'dev-marker.txt');
  initRepo(frontendDir, 'feat/foo', 'foo-marker.txt');

  config = {
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    repos: { backend: backendDir, frontend: frontendDir },
    groups: { grp: ['backend', 'frontend'] },
    copyFiles: [],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('setupWorktree — group with per-repo bases', () => {
  it('forks each repo from its own base and records them', async () => {
    const spec = parseBaseSpec(['backend=dev', 'frontend=feat/foo']);
    const result = await setupWorktree('grp', 'feature/x', config, spec);

    expect(result).not.toBeNull();
    const backendWt = path.join(config.worktreesRoot, 'grp', 'feature-x', 'backend');
    const frontendWt = path.join(config.worktreesRoot, 'grp', 'feature-x', 'frontend');

    // Both worktrees on the new branch...
    expect(getCurrentBranch(backendWt)).toBe('feature/x');
    expect(getCurrentBranch(frontendWt)).toBe('feature/x');

    // ...but forked from different bases: each carries only its own base marker.
    expect(fs.existsSync(path.join(backendWt, 'dev-marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(backendWt, 'foo-marker.txt'))).toBe(false);
    expect(fs.existsSync(path.join(frontendWt, 'foo-marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(frontendWt, 'dev-marker.txt'))).toBe(false);

    // Session records the per-repo bases keyed by worktree path.
    const session = loadHistory().find((s) => s.target === 'grp');
    expect(session?.baseBranches?.[backendWt]).toBe('dev');
    expect(session?.baseBranches?.[frontendWt]).toBe('feat/foo');
  });

  it('applies a bare default base to repos without an override', async () => {
    const spec = parseBaseSpec(['dev', 'frontend=feat/foo']);
    const result = await setupWorktree('grp', 'feature/y', config, spec);

    expect(result).not.toBeNull();
    const backendWt = path.join(config.worktreesRoot, 'grp', 'feature-y', 'backend');
    // backend has no override → forks the default `dev`.
    expect(fs.existsSync(path.join(backendWt, 'dev-marker.txt'))).toBe(true);

    const session = loadHistory().find((s) => s.target === 'grp');
    expect(session?.baseBranches?.[backendWt]).toBe('dev');
  });

  it('rejects a base branch missing from one repo', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // `dev` exists in backend but not in frontend.
    const spec = parseBaseSpec('dev');
    const result = await setupWorktree('grp', 'feature/z', config, spec);

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('frontend (dev)'),
    );
    // Nothing created.
    expect(fs.existsSync(path.join(config.worktreesRoot, 'grp', 'feature-z'))).toBe(
      false,
    );
  });

  it('rejects an override naming a repo outside the group', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spec = parseBaseSpec('mobile=dev');
    const result = await setupWorktree('grp', 'feature/w', config, spec);

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('mobile'));
  });
});
