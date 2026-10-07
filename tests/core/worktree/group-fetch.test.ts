import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkConfig } from '../../../src/core/platform/config.js';

/**
 * A group's repos fetch at once before they're set up (the network was most
 * of each repo's wait), each then skipping its own fetch — but only the repos
 * whose worktree is new: re-entering a group pulls instead, and with
 * --no-pull touches no network.
 */
const h = vi.hoisted(() => ({ fetched: [] as string[] }));
vi.mock('../../../src/core/git/git.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/git/git.js')>();
  return {
    ...actual,
    fetchRemoteAsync: async (cwd: string) => {
      h.fetched.push(path.basename(cwd));
      return actual.fetchRemoteAsync(cwd);
    },
  };
});
import { git } from '../../../src/core/git/git.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';

let home: string;
let config: WorkConfig;
const commitIn = (dir: string, file: string, msg: string) => {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', msg, '--no-gpg-sign'], dir);
};

/** An upstream on main, and a clone of it as the configured repo. */
function repoWithOrigin(name: string) {
  const up = path.join(home, 'origins', name);
  fs.mkdirSync(up, { recursive: true });
  git(['init', '-q', '-b', 'main'], up);
  git(['config', 'user.email', 't@t.t'], up);
  git(['config', 'user.name', 'Test'], up);
  commitIn(up, 'base.txt', name);
  const clone = path.join(home, 'repos', name);
  git(['clone', '-q', up, clone], home);
  git(['config', 'user.email', 't@t.t'], clone);
  git(['config', 'user.name', 'Test'], clone);
  return { up, clone };
}

beforeEach(() => {
  h.fetched.length = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-fetch-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a group fetches its new repos at once', () => {
  it('creating: every repo fetched up front — a branch pushed since the clone is found and tracked', async () => {
    const backend = repoWithOrigin('backend');
    const frontend = repoWithOrigin('frontend');
    // Someone pushed feat/x to both after the clones: only a fetch finds it.
    for (const r of [backend, frontend]) {
      git(['checkout', '-q', '-b', 'feat/x'], r.up);
      commitIn(r.up, 'x.txt', 'pushed');
    }
    config = {
      worktreesRoot: path.join(home, 'worktrees'),
      repos: { backend: backend.clone, frontend: frontend.clone },
      groups: { grp: ['backend', 'frontend'] },
      copyFiles: [],
    };
    const result = await setupWorktree('grp', 'feat/x', config);
    expect(result).not.toBeNull();
    expect(h.fetched.sort()).toEqual(['backend', 'frontend']);
    for (const name of ['backend', 'frontend']) {
      const wt = path.join(config.worktreesRoot, 'grp', 'feat-x', name);
      expect(fs.existsSync(path.join(wt, 'x.txt'))).toBe(true);
    }

    // Re-entering: the worktrees exist — no up-front fetch (each pulls instead, or not at all).
    h.fetched.length = 0;
    expect(await setupWorktree('grp', 'feat/x', config, undefined, undefined, { pull: false })).not.toBeNull();
    expect(h.fetched).toEqual([]);
  }, 60_000);
});
