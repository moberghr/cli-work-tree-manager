import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveHistory, type WorktreeSession } from '../../src/core/sessions/history.js';
import { completeGroupBranches } from '../../src/completions/index.js';

/** TAB after `work tree <group>`: its branches on disk and, for a flat session folder (not under the group's folder), as recorded. */

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'complete-group-')));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const row = (over: Partial<WorktreeSession>): WorktreeSession => ({
  target: 'shop',
  isGroup: true,
  branch: 'b',
  paths: [],
  createdAt: '',
  lastAccessedAt: '',
  ...over,
});
const complete = (current: string, config: Parameters<typeof completeGroupBranches>[3]) =>
  new Promise<string[]>((resolve) => void completeGroupBranches('shop', ['api'], current, config, resolve));

describe('completeGroupBranches', () => {
  it('folders on disk and recorded branches, once each, live ones only, by what was typed', async () => {
    const root = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(root, 'shop', 'feat-old'), { recursive: true });
    saveHistory([
      row({ branch: 'feat/flat', paths: [path.join(root, 'feat-flat-a3f9c2', 'api')] }),
      row({ branch: 'feat-old', paths: [path.join(root, 'shop', 'feat-old', 'api')] }), // also on disk: once
      row({ branch: 'feat/gone', archivedAt: 'x' }),
      row({ target: 'admin', branch: 'feat/other' }),
    ]);
    const config = { worktreesRoot: root, repos: { api: path.join(tmp, 'api') }, groups: { shop: ['api'] }, copyFiles: [] };
    expect((await complete('feat', config)).sort()).toEqual(['feat-old', 'feat/flat']);
    expect(await complete('x', config)).toEqual([]);
  });

  it('no group folder at all: the recorded ones (a group made only with flat folders)', async () => {
    saveHistory([row({ branch: 'feat/flat' })]);
    const config = { worktreesRoot: path.join(tmp, 'none'), repos: {}, groups: { shop: [] }, copyFiles: [] };
    expect(await complete('', config)).toEqual(['feat/flat']);
  });
});
