import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, getCurrentBranch } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { isLeftover, isWorktreeFolder, putLeftoverBack, setLeftoverAside, takeLeftover } from '../../../src/core/worktree/leftover.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('a folder git removed only in part', () => {
  it('is one with no .git: a worktree has its .git (a file), a missing folder is neither', () => {
    const dir = path.join(tmp, 'wt');
    expect(isLeftover(dir)).toBe(false);
    write(path.join(dir, 'a.txt'), 'x');
    expect(isLeftover(dir)).toBe(true);
    write(path.join(dir, '.git'), 'gitdir: x');
    expect(isWorktreeFolder(dir)).toBe(true);
    expect(isLeftover(dir)).toBe(false);
  });

  it('is set aside beside itself, and taken once', () => {
    const dir = path.join(tmp, 'wt');
    write(path.join(dir, 'a.txt'), 'x');
    const aside = setLeftoverAside(dir, new Date('2026-10-08T09:30:15Z'));
    expect(aside).toBe(`${dir}.leftover-20261008-093015`);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(aside, 'a.txt'), 'utf-8')).toBe('x');
    expect(takeLeftover(dir)).toBe(aside);
    expect(takeLeftover(dir)).toBeNull();
  });

  it('comes back over the checkout, or (after the archive save) only where nothing is; build output stays out; then it goes', () => {
    const aside = path.join(tmp, 'aside');
    const wt = path.join(tmp, 'new');
    write(path.join(aside, 'src', 'A.cs'), 'mine');
    write(path.join(aside, 'Helper.cs'), 'helper');
    write(path.join(aside, 'bin', 'Debug', 'A.dll'), 'binary');
    write(path.join(wt, 'src', 'A.cs'), 'committed');

    expect(putLeftoverBack(aside, wt, { overwrite: false })).toEqual({ copied: 1, failed: [], removed: true });
    expect(fs.readFileSync(path.join(wt, 'src', 'A.cs'), 'utf-8')).toBe('committed');
    expect(fs.readFileSync(path.join(wt, 'Helper.cs'), 'utf-8')).toBe('helper');
    expect(fs.existsSync(path.join(wt, 'bin'))).toBe(false);
    expect(fs.existsSync(aside)).toBe(false);

    write(path.join(aside, 'src', 'A.cs'), 'mine');
    expect(putLeftoverBack(aside, wt, { overwrite: true }).copied).toBe(1);
    expect(fs.readFileSync(path.join(wt, 'src', 'A.cs'), 'utf-8')).toBe('mine');
  });
});

describe('making the worktree again over what was left (real git)', () => {
  it("a session whose worktree git half-removed comes back on its branch, with the files that were left in it (reported: a 'detached' restore)", async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 'T'], repo);
    write(path.join(repo, 'README.md'), '# v1\n');
    write(path.join(repo, 'src', 'Kept.cs'), 'committed\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
    const config: WorkConfig = { worktreesRoot: path.join(tmp, 'worktrees'), repos: { api: repo }, groups: {}, copyFiles: [] };
    saveConfig(config);

    const first = await setupWorktree('api', 'accounting/missing-payment', config, undefined, undefined, { pull: false });
    const wt = first!.paths[0];
    write(path.join(wt, 'README.md'), '# changed, not committed\n');
    write(path.join(wt, 'CreateDoublePaymentCorrection.cs'), 'one-off\n');
    write(path.join(wt, 'bin', 'Debug', 'App.dll'), 'build output');
    // What `git worktree remove` leaves when it stops at a file in use: some files gone, no .git, unregistered.
    fs.rmSync(path.join(wt, 'src'), { recursive: true });
    fs.rmSync(path.join(wt, '.git'));
    git(['worktree', 'prune'], repo);
    expect(isLeftover(wt)).toBe(true);

    const again = await setupWorktree('api', 'accounting/missing-payment', config, undefined, undefined, { pull: false });
    expect(again?.paths).toEqual([wt]);
    expect(getCurrentBranch(wt)).toBe('accounting/missing-payment');
    expect(fs.readFileSync(path.join(wt, 'README.md'), 'utf-8')).toBe('# changed, not committed\n');
    expect(fs.readFileSync(path.join(wt, 'CreateDoublePaymentCorrection.cs'), 'utf-8')).toBe('one-off\n');
    expect(fs.readFileSync(path.join(wt, 'src', 'Kept.cs'), 'utf-8')).toBe('committed\n'); // deleted by git: back from the branch
    expect(fs.existsSync(path.join(wt, 'bin'))).toBe(false);
    expect(fs.readdirSync(path.dirname(wt)).filter((f) => f.includes('.leftover-'))).toEqual([]);
  });
});
