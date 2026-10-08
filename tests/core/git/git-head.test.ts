import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchFromHead, checkedOutBranch } from '../../../src/core/git/git-head.js';
import { otherBranches } from '../../../src/core/sessions/session-wire.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A worktree as git lays it out: `.git` is a file pointing at the repo's worktrees/<name>, whose HEAD names the branch. */
function worktree(name: string, head: string): string {
  const gitDir = path.join(tmp, 'repo', '.git', 'worktrees', name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), head);
  const wt = path.join(tmp, 'wt', name);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  return wt;
}

describe('checkedOutBranch', () => {
  it("reads a worktree's branch through its .git file, and a base checkout's from .git/HEAD", () => {
    expect(checkedOutBranch(worktree('a', 'ref: refs/heads/task/SD-3937-split-user-system-notes\n'))).toBe(
      'task/SD-3937-split-user-system-notes',
    );
    fs.mkdirSync(path.join(tmp, 'base', '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'base', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(checkedOutBranch(path.join(tmp, 'base'))).toBe('main');
  });

  it('null for a detached HEAD, a missing folder, or not a checkout', () => {
    expect(checkedOutBranch(worktree('b', '0123456789abcdef0123456789abcdef01234567\n'))).toBeNull();
    expect(checkedOutBranch(path.join(tmp, 'nope'))).toBeNull();
    expect(branchFromHead('garbage')).toBeNull();
  });
});

describe('otherBranches (the session wire)', () => {
  it('names the repos on another branch than the session’s, and nothing when they match', () => {
    const wt = worktree('c', 'ref: refs/heads/fix/terminal-encryption-key-nexo\n');
    const s = { target: 'straumur-backend', branch: 'tmp/encryption-keys', isGroup: false, paths: [wt] };
    expect(otherBranches(s)).toEqual({ onOtherBranch: [{ repo: 'straumur-backend', branch: 'fix/terminal-encryption-key-nexo' }] });
    expect(otherBranches({ ...s, branch: 'fix/terminal-encryption-key-nexo' })).toEqual({});
    expect(otherBranches({ ...s, archivedAt: 'x' })).toEqual({}); // archived: not shown
  });

  it('a folder with no git left in it (a removal that stopped halfway) says so — not "detached" (reported)', () => {
    const left = path.join(tmp, 'accounting-missing-payment');
    fs.mkdirSync(path.join(left, 'src'), { recursive: true });
    const s = { target: 'straumur-backend', branch: 'accounting/missing-payment', isGroup: false, paths: [left] };
    expect(otherBranches(s)).toEqual({ onOtherBranch: [{ repo: 'straumur-backend', branch: null, noGit: true }] });
  });

  it('a group names each repo by its folder', () => {
    const be = worktree('straumur-backend-ai', 'ref: refs/heads/task/notes-split\n');
    const fe = worktree('straumur-frontend-ai', 'ref: refs/heads/task/SD-3937\n');
    expect(otherBranches({ target: 'straumur', branch: 'task/notes-split', isGroup: true, paths: [be, fe] })).toEqual({
      onOtherBranch: [{ repo: 'straumur-frontend-ai', branch: 'task/SD-3937' }],
    });
  });
});
