import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { branchCheckedOut, shadowedSessions } from '../../../src/core/worktree/shared-folders.js';

const s = (branch: string, dir: string, lastAccessedAt = '2026-09-01T00:00:00Z'): WorktreeSession =>
  ({ target: 'work-tree', branch, isGroup: false, paths: [dir], createdAt: lastAccessedAt, lastAccessedAt }) as WorktreeSession;

describe('shadowedSessions', () => {
  it('gives a shared folder to the branch checked out there', () => {
    const main = s('main', '/repo/work-tree', '2026-09-01T00:00:00Z');
    const old = s('feat/wd-dark-theme', '/repo/work-tree', '2026-09-20T00:00:00Z');
    const own = s('feat/x', '/wt/x');
    const out = shadowedSessions([main, old, own], () => 'main');
    expect([...out]).toEqual([sessionIdFor(old)]);
  });

  it('falls back to the entry used last when no entry matches the checkout', () => {
    const a = s('feat/a', '/repo/r', '2026-09-01T00:00:00Z');
    const b = s('feat/b', '/repo/r', '2026-09-20T00:00:00Z');
    expect([...shadowedSessions([a, b], () => null)]).toEqual([sessionIdFor(a)]);
  });
});

describe('branchCheckedOut', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a checkout and a linked worktree, and null when detached', () => {
    fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/feat/login\n');
    expect(branchCheckedOut(path.join(dir, 'repo'))).toBe('feat/login');

    fs.mkdirSync(path.join(dir, 'repo', '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'repo', '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/fix/x\n');
    fs.mkdirSync(path.join(dir, 'wt'));
    fs.writeFileSync(path.join(dir, 'wt', '.git'), `gitdir: ${path.join(dir, 'repo', '.git', 'worktrees', 'wt')}\n`);
    expect(branchCheckedOut(path.join(dir, 'wt'))).toBe('fix/x');

    fs.writeFileSync(path.join(dir, 'repo', '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(branchCheckedOut(path.join(dir, 'repo'))).toBeNull();
    expect(branchCheckedOut(path.join(dir, 'nothing'))).toBeNull();
  });
});
