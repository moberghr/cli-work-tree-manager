import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from '../../../src/core/git/git.js';
import type { WorkConfig } from '../../../src/core/platform/config.js';
import { hydrateHistoryFromDisk } from '../../../src/core/sessions/hydrate.js';
import { findSession, loadHistory } from '../../../src/core/sessions/history.js';

/**
 * Rebuilding sessions from `git worktree list`: the old single-repo layout
 * (`<root>/<repo-folder>/<branch>`), a group's, and a session folder of a repo
 * (`<root>/<alias>/<branch>/<repo-folder>`, config `sessionFolders`).
 */

let fixture: string;
let tmp: string;
let config: WorkConfig;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrate-fixture-'));
  for (const name of ['api-repo', 'web-repo']) {
    const dir = path.join(fixture, name);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  }
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hydrate-')));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  fs.cpSync(fixture, path.join(tmp, 'src'), { recursive: true });
  config = {
    worktreesRoot: path.join(tmp, 'worktrees'),
    repos: { api: path.join(tmp, 'src', 'api-repo'), web: path.join(tmp, 'src', 'web-repo') },
    groups: { shop: ['api', 'web'] },
    copyFiles: [],
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const norm = (p: string) => path.resolve(p).toLowerCase();
function addWorktree(alias: string, branch: string, ...where: string[]): string {
  const wt = path.join(config.worktreesRoot, ...where);
  expect(git(['worktree', 'add', wt, '-b', branch], config.repos[alias]).exitCode).toBe(0);
  return wt;
}

describe('hydrateHistoryFromDisk', () => {
  it('the old single-repo layout is a single session, as before', async () => {
    const wt = addWorktree('api', 'feat/old', 'api-repo', 'feat-old');
    await hydrateHistoryFromDisk(config);
    const row = findSession(loadHistory(), 'api', 'feat/old');
    expect(row).toMatchObject({ target: 'api', isGroup: false, repos: ['api'] });
    expect(row?.paths.map(norm)).toEqual([norm(wt)]);
  }, 60_000);

  it("a repo's session folder is a folder session: the alias its target, isGroup, its repos recorded", async () => {
    const api = addWorktree('api', 'feat/x', 'api', 'feat-x', 'api-repo');
    const web = addWorktree('web', 'feat/x', 'api', 'feat-x', 'web-repo'); // a repo added to it
    await hydrateHistoryFromDisk(config);
    const row = findSession(loadHistory(), 'api', 'feat/x');
    expect(row).toMatchObject({ target: 'api', isGroup: true, repos: ['api', 'web'] });
    expect(row?.paths.map(norm)).toEqual([norm(api), norm(web)]);
    expect(findSession(loadHistory(), 'web', 'feat/x')).toBeUndefined();
  }, 60_000);

  it('a session folder named by the repo folder (not the alias) belongs to that repo', async () => {
    addWorktree('api', 'feat/y', 'api-repo', 'feat-y', 'api-repo');
    await hydrateHistoryFromDisk(config);
    expect(findSession(loadHistory(), 'api', 'feat/y')).toMatchObject({ target: 'api', isGroup: true, repos: ['api'] });
  }, 60_000);

  it('a group worktree stays a group session', async () => {
    addWorktree('api', 'feat/g', 'shop', 'feat-g', 'api-repo');
    addWorktree('web', 'feat/g', 'shop', 'feat-g', 'web-repo');
    await hydrateHistoryFromDisk(config);
    expect(findSession(loadHistory(), 'shop', 'feat/g')).toMatchObject({ isGroup: true, repos: ['api', 'web'] });
  }, 60_000);

  it('a deeper path that is not a session folder (last part not the repo folder) is no session', async () => {
    addWorktree('api', 'feat/z', 'api', 'feat-z', 'other');
    await hydrateHistoryFromDisk(config);
    expect(loadHistory().filter((s) => s.branch === 'feat/z')).toEqual([]);
  }, 60_000);
});
