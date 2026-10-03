import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeSession, saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { takeCheckpoint, manifestPath } from '../../../src/core/diff/checkpoint.js';
import { scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cp-'));
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('removing a session clears its checkpoints', () => {
  it('its refs/wd/<hash>/* refs and its manifest go with it, even when the worktree is already gone', async () => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    git(repo, 'add', 'a');
    git(repo, 'commit', '-q', '-m', 'a');
    const wt = path.join(home, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    saveConfig({ worktreesRoot: home, repos: { api: repo }, groups: {}, copyFiles: [] } as WorkConfig);
    const s: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
    saveHistory([s]);
    const hash = scopeHashForPaths(s.paths);
    await takeCheckpoint(hash, [{ name: 'api', root: wt }]);
    fs.writeFileSync(path.join(wt, 'b'), 'b');
    await takeCheckpoint(hash, [{ name: 'api', root: wt }]);
    expect(git(repo, 'for-each-ref', `refs/wd/${hash}`)).not.toBe('');
    git(repo, 'worktree', 'remove', '--force', wt);
    await removeSession('api', 'feat/x');
    expect(git(repo, 'for-each-ref', `refs/wd/${hash}`)).toBe('');
    expect(fs.existsSync(manifestPath(hash))).toBe(false);
  }, 60_000);
});
