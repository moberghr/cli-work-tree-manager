import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  buildRepoSpecs,
  resolveBase,
  resolveScope,
} from '../../src/core/diff-scope.js';
import {
  saveHistory,
  type WorktreeSession,
} from '../../src/core/history.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ds-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  // Make a real git repo so the rev-parse fallback path can run.
  repoDir = path.join(tmpDir, 'extern-repo');
  fs.mkdirSync(repoDir);
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email t@t.t', { cwd: repoDir });
  execSync('git config user.name t', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: repoDir });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function session(over: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    target: 'repo',
    isGroup: false,
    branch: 'feat/x',
    paths: ['C:/work/repo'],
    createdAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('resolveScope', () => {
  it('matches a single-repo worktree exactly', () => {
    saveHistory([session({ paths: ['C:/work/repo'] })]);
    const scope = resolveScope('C:/work/repo');
    expect(scope).not.toBeNull();
    expect(scope!.isGroup).toBe(false);
    expect(scope!.repos[0].name).toBe('repo');
    expect(scope!.activeRepoName).toBe('repo');
  });

  it('matches a subdirectory of a worktree', () => {
    saveHistory([session({ paths: ['C:/work/repo'] })]);
    const scope = resolveScope('C:/work/repo/src/sub');
    expect(scope?.repos[0].name).toBe('repo');
    expect(scope?.activeRepoName).toBe('repo');
  });

  it('inside a sub-repo of a group: returns the group with that sub as active', () => {
    saveHistory([
      session({
        isGroup: true,
        paths: ['C:/work/group/api', 'C:/work/group/web'],
      }),
    ]);
    const scope = resolveScope('C:/work/group/api/src');
    expect(scope!.isGroup).toBe(true);
    expect(scope!.repos.map((r) => r.name).sort()).toEqual(['api', 'web']);
    expect(scope!.activeRepoName).toBe('api');
  });

  it('at the group root: returns the group with no active sub-repo', () => {
    saveHistory([
      session({
        isGroup: true,
        paths: ['C:/work/group/api', 'C:/work/group/web'],
      }),
    ]);
    const scope = resolveScope('C:/work/group');
    expect(scope!.isGroup).toBe(true);
    expect(scope!.activeRepoName).toBeNull();
  });

  it('resolves a nested worktree to its own root, not the parent session', () => {
    // A linked worktree living physically inside a session repo
    // (<repo>/.claude/worktrees/<branch>) must NOT collapse onto the parent's
    // scope — otherwise two branches share one daemon. Regression test.
    execSync('git worktree add -q -b feat-nested .claude/worktrees/nested', {
      cwd: repoDir,
    });
    const nested = path.join(repoDir, '.claude', 'worktrees', 'nested');
    // The parent repo is a known session; the nested worktree is not.
    saveHistory([session({ paths: [repoDir] })]);

    const scope = resolveScope(nested);
    expect(scope).not.toBeNull();
    expect(scope!.session).toBeNull(); // parent match rejected
    // Root is the nested worktree itself, so its scope hash differs.
    expect(path.basename(scope!.repos[0].root)).toBe('nested');
  });

  it('still matches the parent session from a subdirectory of that same worktree', () => {
    // Guard against over-correction: a plain subdir (same worktree, same
    // toplevel) must still resolve to the session.
    const sub = path.join(repoDir, 'src');
    fs.mkdirSync(sub);
    saveHistory([session({ paths: [repoDir] })]);
    const scope = resolveScope(sub);
    expect(scope!.session).not.toBeNull();
    expect(path.basename(scope!.repos[0].root)).toBe(path.basename(repoDir));
  });

  it('falls back to git rev-parse for unknown cwds inside a real repo', () => {
    saveHistory([]);
    const scope = resolveScope(repoDir);
    expect(scope).not.toBeNull();
    expect(scope!.isGroup).toBe(false);
    expect(scope!.repos[0].name).toBe(path.basename(repoDir));
  });

  it('returns null when cwd is not a git repo and not a known session', () => {
    saveHistory([]);
    const orphan = fs.mkdtempSync(path.join(tmpDir, 'orphan-'));
    expect(resolveScope(orphan)).toBeNull();
  });
});

describe('resolveBase', () => {
  it('returns the explicit base when one is passed', () => {
    saveHistory([]);
    const scope = resolveScope(repoDir)!;
    expect(resolveBase(scope, { base: 'origin/main' })).toEqual({
      base: 'origin/main',
      source: 'arg',
    });
  });

  it("uses the session's baseBranch when --branch is set", () => {
    const s = session({
      paths: [repoDir],
      baseBranch: 'develop',
    });
    saveHistory([s]);
    const scope = resolveScope(repoDir)!;
    expect(resolveBase(scope, { branch: true })).toEqual({
      base: 'develop',
      source: 'session',
    });
  });

  it('defaults to HEAD when neither base nor --branch is given', () => {
    saveHistory([]);
    const scope = resolveScope(repoDir)!;
    expect(resolveBase(scope, {})).toEqual({ base: 'HEAD', source: 'default' });
  });
});

describe('buildRepoSpecs', () => {
  it('passes HEAD straight through (no merge-base lookup)', () => {
    saveHistory([]);
    const scope = resolveScope(repoDir)!;
    const specs = buildRepoSpecs(scope, 'HEAD');
    expect(specs).toHaveLength(1);
    expect(specs[0].diffArg).toBe('HEAD');
    // git rev-parse normalises to forward slashes on Windows — compare
    // via path.basename rather than the raw string.
    expect(path.basename(specs[0].root)).toBe(path.basename(repoDir));
  });
});
