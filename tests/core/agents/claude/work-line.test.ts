import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountLabel, branchLabel, folderLabel, readLineConfig, workStatusLine } from '../../../../src/core/agents/claude/work-line.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-line-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** A checkout made of files only: `.git/HEAD` saying `head`. */
function checkout(name: string, head: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
  return dir;
}

describe('readLineConfig', () => {
  it('reads the choice and the accounts, ignoring what is not a folder', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ claudeStatusLine: 'work', claudeAccounts: { admin: 'C:/x/.claude-admin', bad: 3 } }));
    expect(readLineConfig(file)).toEqual({ choice: 'work', accounts: { admin: 'C:/x/.claude-admin' } });
  });

  it('a missing, broken or odd file, or an unknown choice, is nothing chosen', () => {
    const none = { choice: null, accounts: {} };
    expect(readLineConfig(path.join(tmp, 'nope.json'))).toEqual(none);
    fs.writeFileSync(path.join(tmp, 'b.json'), '{broken');
    expect(readLineConfig(path.join(tmp, 'b.json'))).toEqual(none);
    fs.writeFileSync(path.join(tmp, 'c.json'), JSON.stringify({ claudeStatusLine: 'fancy' }));
    expect(readLineConfig(path.join(tmp, 'c.json'))).toEqual(none);
  });
});

describe('accountLabel', () => {
  const home = path.join(tmp ?? os.tmpdir(), 'home');
  it('one account and no CLAUDE_CONFIG_DIR: nothing to tell apart', () => {
    expect(accountLabel(undefined, {}, home)).toBeNull();
  });
  it('~/.claude is default, given or not, once there are several', () => {
    expect(accountLabel(undefined, { admin: '/a' }, home)).toBe('default');
    expect(accountLabel(path.join(home, '.claude'), {}, home)).toBe('default');
  });
  it("another folder: its name in claudeAccounts (~ expanded), else the folder's name", () => {
    const admin = path.join(home, '.claude-admin');
    expect(accountLabel(admin, { admin: '~/.claude-admin' }, home)).toBe('admin');
    expect(accountLabel(path.join(home, '.claude-side'), { admin: admin }, home)).toBe('side');
  });
  it.runIf(process.platform === 'win32')('Windows paths are the same whatever their case and slashes', () => {
    expect(accountLabel('C:\\Users\\Me\\.Claude-Admin\\', { admin: 'c:/users/me/.claude-admin' }, 'C:\\Users\\Me', 'win32')).toBe('admin');
  });
});

describe('branchLabel', () => {
  it('the branch, from a subfolder too; the short commit when detached; null outside a checkout', () => {
    const repo = checkout('repo', 'ref: refs/heads/feat/x\n');
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    expect(branchLabel(repo)).toBe('feat/x');
    expect(branchLabel(path.join(repo, 'src', 'deep'))).toBe('feat/x');
    expect(branchLabel(checkout('detached', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n'))).toBe('a1b2c3d');
    const outside = path.join(tmp, 'plain');
    fs.mkdirSync(outside);
    expect(branchLabel(outside)).toBeNull();
  });

  it("a worktree's .git file names its own HEAD", () => {
    const gitdir = path.join(tmp, 'main', '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/fix/y\n');
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(branchLabel(wt)).toBe('fix/y');
  });
});

describe('folderLabel', () => {
  it('under home as ~/…, elsewhere as it is', () => {
    const home = path.join(tmp, 'home');
    expect(folderLabel(home, home)).toBe('~');
    expect(folderLabel(path.join(home, 'source', 'repos'), home)).toBe('~/source/repos');
    expect(folderLabel(path.join(tmp, 'other'), home)).toBe(path.join(tmp, 'other'));
  });
});

describe('workStatusLine', () => {
  it('model and context, account, folder and branch, in colour', () => {
    const home = path.join(tmp, 'home');
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const line = workStatusLine(
      { model: { display_name: 'Opus' }, context_window: { used_percentage: 41.6 }, workspace: { current_dir: repo } },
      { configDir: path.join(home, '.claude-admin'), accounts: { admin: path.join(home, '.claude-admin') }, home },
    );
    expect(strip(line)).toBe('Opus (42%) admin ~/repo main');
    expect(line).toContain('\x1b[0;36mOpus\x1b[0m');
  });

  it('leaves out what it was not given: no context, one account, no folder', () => {
    expect(strip(workStatusLine({ model: { display_name: 'Sonnet' } }, { home: tmp }))).toBe('Sonnet');
    expect(workStatusLine(null)).toBe('');
  });
});
