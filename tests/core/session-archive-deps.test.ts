import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { defaultArchiveDeps } from '../../src/core/session-archive-deps.js';

// tests/setup gives every file its own HOME, so this config is a throwaway.
let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-deps-repo-'));
  fs.mkdirSync(path.join(os.homedir(), '.work'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.work', 'config.json'), JSON.stringify({ worktreesRoot: os.tmpdir(), repos: { api: repo }, groups: {}, copyFiles: [] }));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const session = (paths: string[]): WorktreeSession =>
  ({ target: 'api', branch: 'main', isGroup: false, paths, createdAt: '', lastAccessedAt: '' }) as WorktreeSession;

describe('defaultArchiveDeps().removable', () => {
  it("never removes the repo's own checkout", async () => {
    expect(await defaultArchiveDeps().removable(session([repo]))).toEqual({ ok: false, reason: "it is the repo's own checkout" });
  });

  it('a worktree that is already gone is fine to "remove"', async () => {
    expect((await defaultArchiveDeps().removable(session([path.join(repo, '..', 'no-such-worktree')]))).ok).toBe(true);
  });
});
