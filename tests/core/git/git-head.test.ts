import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchFromHead, checkedOutBranch, refShaFromFiles, workingBranch } from '../../../src/core/git/git-head.js';
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
    expect(checkedOutBranch(worktree('a', 'ref: refs/heads/task/APP-3937-split-user-system-notes\n'))).toBe(
      'task/APP-3937-split-user-system-notes',
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

describe('workingBranch', () => {
  it('the branch checked out, or mid-rebase (HEAD detached) the one being rebased; else null', () => {
    expect(workingBranch(worktree('w1', 'ref: refs/heads/feat/x\n'))).toBe('feat/x');
    const wt = worktree('w2', '0123456789abcdef0123456789abcdef01234567\n');
    expect(workingBranch(wt)).toBeNull();
    const gitDir = path.join(tmp, 'repo', '.git', 'worktrees', 'w2');
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feat/x\n');
    expect(workingBranch(wt)).toBe('feat/x');
    expect(checkedOutBranch(wt)).toBeNull(); // the plain reading stays as it was
  });
});

describe('refShaFromFiles', () => {
  it('HEAD through the branch it names, a loose ref, a packed one; null when the files say nothing', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const wt = worktree('r1', 'ref: refs/heads/feat/x\n');
    const common = path.join(tmp, 'repo', '.git');
    fs.mkdirSync(path.join(common, 'refs', 'heads', 'feat'), { recursive: true });
    fs.writeFileSync(path.join(common, 'refs', 'heads', 'feat', 'x'), `${a}\n`);
    fs.writeFileSync(path.join(common, 'packed-refs'), `# pack-refs with: peeled\n${b} refs/heads/old/one\n`);
    // A worktree's commondir file, as git writes it.
    fs.writeFileSync(path.join(common, 'worktrees', 'r1', 'commondir'), '../..\n');
    expect(refShaFromFiles(wt, 'HEAD')).toBe(a);
    expect(refShaFromFiles(wt, 'refs/heads/feat/x')).toBe(a);
    expect(refShaFromFiles(wt, 'refs/heads/old/one')).toBe(b);
    expect(refShaFromFiles(wt, 'refs/heads/no/such')).toBeNull();
    expect(refShaFromFiles(worktree('r2', `${b}\n`), 'HEAD')).toBe(b); // detached
  });
});

describe('otherBranches (the session wire)', () => {
  it('names the repos on another branch than the session’s, and nothing when they match', () => {
    const wt = worktree('c', 'ref: refs/heads/fix/terminal-encryption-key-nexo\n');
    const s = { target: 'acme-backend', branch: 'tmp/encryption-keys', isGroup: false, paths: [wt] };
    expect(otherBranches(s)).toEqual({ onOtherBranch: [{ repo: 'acme-backend', branch: 'fix/terminal-encryption-key-nexo' }] });
    expect(otherBranches({ ...s, branch: 'fix/terminal-encryption-key-nexo' })).toEqual({});
    expect(otherBranches({ ...s, archivedAt: 'x' })).toEqual({}); // archived: not shown
  });

  it('a folder with no git left in it (a removal that stopped halfway) says so — not "detached" (reported)', () => {
    const left = path.join(tmp, 'accounting-missing-payment');
    fs.mkdirSync(path.join(left, 'src'), { recursive: true });
    const s = { target: 'acme-backend', branch: 'accounting/missing-payment', isGroup: false, paths: [left] };
    expect(otherBranches(s)).toEqual({ onOtherBranch: [{ repo: 'acme-backend', branch: null, noGit: true }] });
  });

  it('a group names each repo by its folder', () => {
    const be = worktree('acme-backend-ai', 'ref: refs/heads/task/notes-split\n');
    const fe = worktree('acme-frontend-ai', 'ref: refs/heads/task/APP-3937\n');
    expect(otherBranches({ target: 'acme', branch: 'task/notes-split', isGroup: true, paths: [be, fe] })).toEqual({
      onOtherBranch: [{ repo: 'acme-frontend-ai', branch: 'task/APP-3937' }],
    });
  });
});
