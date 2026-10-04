import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkTools,
  DEFAULT_COPY_FILES,
  folderProblem,
  saveFolders,
  setupState,
  suggestFolders,
} from '../../../src/core/setup/first-run.js';
import { getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('suggestFolders', () => {
  it('the usual repos folder that exists, worktrees beside it; none: worktrees under home', () => {
    const at =
      (...have: string[]) =>
      (p: string) =>
        have.includes(p);
    expect(suggestFolders('/h', at(path.join('/h', 'source', 'repos'), path.join('/h', 'code')))).toEqual({
      reposFolder: path.join('/h', 'source', 'repos'),
      worktreesRoot: path.join('/h', 'source', 'worktrees'),
    });
    expect(suggestFolders('/h', at(path.join('/h', 'code')))).toEqual({
      reposFolder: path.join('/h', 'code'),
      worktreesRoot: path.join('/h', 'worktrees'),
    });
    expect(suggestFolders('/h', at())).toEqual({ reposFolder: null, worktreesRoot: path.join('/h', 'worktrees') });
  });
});

describe('saveFolders', () => {
  it('first run: config.json made with the folders and work init’s defaults, the worktrees folder created', async () => {
    const repos = path.join(home, 'src');
    fs.mkdirSync(repos);
    await saveFolders({ worktreesRoot: path.join(home, 'wt'), reposFolder: repos });
    const c = loadConfig()!;
    expect(c).toMatchObject({
      worktreesRoot: path.join(home, 'wt'),
      scanRoots: [repos],
      repos: {},
      groups: {},
      copyFiles: DEFAULT_COPY_FILES,
    });
    expect(fs.existsSync(path.join(home, 'wt'))).toBe(true);
  });

  it('later: only the folders change, every other key stays', async () => {
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ worktreesRoot: '/old', repos: { api: '/r/api' }, groups: {}, copyFiles: [], someFutureKey: 7 }),
    );
    await saveFolders({ worktreesRoot: path.join(home, 'wt'), reposFolder: home });
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({
      worktreesRoot: path.join(home, 'wt'),
      scanRoots: [home],
      repos: { api: '/r/api' },
      copyFiles: [],
      someFutureKey: 7,
    });
  });

  it('refuses a relative or missing folder, saying which', async () => {
    await expect(saveFolders({ worktreesRoot: 'wt', reposFolder: home })).rejects.toThrow(/Worktrees folder: wt isn't a full path/);
    await expect(saveFolders({ worktreesRoot: path.join(home, 'wt'), reposFolder: path.join(home, 'nope') })).rejects.toThrow(
      /Repos folder: .* doesn't exist/,
    );
    expect(folderProblem('  ', false)).toBe('give a folder');
  });
});

describe('checkTools', () => {
  it('a version when it answers; missing says how to get it; gh logged out says to log in', async () => {
    const run: CommandRunner = async (cmd) =>
      cmd === 'git'
        ? { code: 0, stdout: 'git version 2.47.0\n', stderr: '' }
        : cmd === 'gh'
          ? { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
          : { code: 127, stdout: '', stderr: '' };
    const tools = await checkTools(run);
    expect(tools.map((t) => [t.id, t.ok, t.needed])).toEqual([
      ['git', true, true],
      ['claude', false, true],
      ['gh', false, false],
      ['acli', false, false],
    ]);
    expect(tools[0].detail).toBe('git version 2.47.0');
    expect(tools[1].detail).toMatch(/Install Claude Code/);
    expect(tools[2].detail).toMatch(/gh auth login/);
  });
});

describe('setupState', () => {
  it('not configured on a fresh computer, with folders to suggest', async () => {
    fs.mkdirSync(path.join(home, 'source', 'repos'), { recursive: true });
    const s = await setupState(async () => []);
    expect(s).toMatchObject({ configured: false, repos: 0, sessions: 0, suggested: { reposFolder: path.join(home, 'source', 'repos') } });
  });
});
