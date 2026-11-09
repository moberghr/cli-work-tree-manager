import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../../src/core/git/git.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';
import { loadHistory } from '../../../src/core/sessions/history.js';
import { chooseWorktreesRoot, expandHome, makeFolder, worktreeFolderMessage } from '../../../src/core/worktree/worktrees-root.js';
import type { WorkConfig } from '../../../src/core/platform/config.js';

const denied = (code: string) => () => {
  throw Object.assign(new Error(`${code}: nope`), { code });
};

describe('the worktrees folder, made or refused in words (reported: /Users/worktrees on a Mac, EACCES as a stack)', () => {
  it('makeFolder: null when made, else why in words', () => {
    expect(makeFolder('/x', () => {})).toBeNull();
    expect(makeFolder('/Users/worktrees/a', denied('EACCES'))).toBe("can't create /Users/worktrees/a: permission denied");
    expect(makeFolder('/r', denied('EROFS'))).toBe("can't create /r: the disk is read-only");
    expect(makeFolder('/f', denied('ENOTDIR'))).toBe("can't create /f: a file is in the way");
  });

  it("the message names the folder, why, and the setting to change, never Node's error", () => {
    const m = worktreeFolderMessage(
      '/Users/worktrees/Arctic',
      '/Users/worktrees',
      "can't create /Users/worktrees/Arctic: permission denied",
    );
    expect(m).toContain("Can't create the worktree folder /Users/worktrees/Arctic: permission denied.");
    expect(m).toContain('worktreesRoot (now /Users/worktrees)');
    expect(m).toContain('work config edit');
    expect(m).not.toContain('EACCES');
  });

  it('a typed folder (work init): ~ expanded, a relative one refused, one that cannot be made refused, else made', () => {
    expect(expandHome('~/wt', '/home/m')).toBe(path.join('/home/m', 'wt'));
    expect(expandHome('~', '/home/m')).toBe('/home/m');
    expect(chooseWorktreesRoot('worktrees', { mkdir: () => {} })).toEqual({ problem: expect.stringContaining("isn't a full path") });
    expect(chooseWorktreesRoot('  ', { mkdir: () => {} })).toEqual({ problem: 'give a folder' });
    const refused = chooseWorktreesRoot('/Users/worktrees', { home: '/Users/matija', mkdir: denied('EACCES') });
    expect('problem' in refused && refused.problem).toBe(
      `can't create ${path.resolve('/Users/worktrees')}: permission denied — pick a folder you own, e.g. under /Users/matija`,
    );
    const made: string[] = [];
    const ok = chooseWorktreesRoot('~/worktrees', { home: path.resolve('/home/m'), mkdir: (p) => void made.push(p) });
    expect(ok).toEqual({ root: path.join(path.resolve('/home/m'), 'worktrees') });
    expect(made).toEqual([path.join(path.resolve('/home/m'), 'worktrees')]);
  });
});

describe('creating a worktree under a folder that cannot be made', () => {
  let tmp: string;
  let repoDir: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-wt-root-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    repoDir = path.join(tmp, 'api');
    fs.mkdirSync(repoDir);
    git(['init', '-b', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# api\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);
    // A file where the worktrees folder should be: no folder can be made under it, on every OS.
    fs.writeFileSync(path.join(tmp, 'worktrees'), 'not a folder');
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is refused with the sentence, records no session, and throws nothing', async () => {
    const config: WorkConfig = { worktreesRoot: path.join(tmp, 'worktrees'), repos: { api: repoDir }, groups: {}, copyFiles: [] };
    const reports = collectingReporter();
    const result = await withReporter(reports, () => setupWorktree('api', 'feat/x', config));
    expect(result).toBeNull();
    const said = reports.errors().join('\n');
    expect(said).toContain("Can't create the worktree folder");
    expect(said).toContain('a file is in the way');
    expect(said).toContain(`worktreesRoot (now ${config.worktreesRoot})`);
    expect(loadHistory()).toEqual([]);
  });

  it('a group too: refused with the sentence, no repo of it made, no session recorded', async () => {
    const config: WorkConfig = {
      worktreesRoot: path.join(tmp, 'worktrees'),
      repos: { api: repoDir },
      groups: { grp: ['api'] },
      copyFiles: [],
    };
    const reports = collectingReporter();
    const result = await withReporter(reports, () => setupWorktree('grp', 'feat/g', config));
    expect(result).toBeNull();
    expect(reports.errors().join(' ')).toContain("Can't create the worktree folder");
    expect(loadHistory()).toEqual([]);
    expect(git(['worktree', 'list', '--porcelain'], repoDir).stdout.match(/^worktree /gm)).toHaveLength(1);
  });
});
