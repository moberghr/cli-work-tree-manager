import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `work tree --pr`: the PR's repo and branch, and a first prompt saying whose branch it is. */

vi.mock('../../src/core/platform/launch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/platform/launch.js')>()),
  launchAi: vi.fn(),
}));
const lookup = vi.hoisted(() => ({ resolvePrToStart: vi.fn() }));
vi.mock('../../src/core/pr/pr-start.js', () => lookup);
const { launchAi } = await import('../../src/core/platform/launch.js');
const { git } = await import('../../src/core/git/git.js');
const { saveConfig } = await import('../../src/core/platform/config.js');
const { loadHistory } = await import('../../src/core/sessions/history.js');
const { treeCommand } = await import('../../src/commands/tree.js');

const PR = {
  alias: 'api',
  number: 12,
  title: 'Add export',
  url: 'https://github.com/acme/api/pull/12',
  branch: 'feat/export',
  base: 'main',
  author: 'ana',
};

let home: string;
let errors: string[];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-pr-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] });
  lookup.resolvePrToStart.mockReset().mockResolvedValue({ ok: true, pr: PR });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const tree = (over: Record<string, unknown>) =>
  (treeCommand.handler as (argv: unknown) => unknown)({ _: [], host: false, pull: false, unsafe: false, fresh: false, ...over });

describe('work tree --pr', () => {
  it("opens a session on the PR's branch in its repo, its Claude told whose branch it is", async () => {
    await tree({ pr: 'https://github.com/acme/api/pull/12' });
    expect(lookup.resolvePrToStart).toHaveBeenCalledWith('https://github.com/acme/api/pull/12', expect.anything(), undefined);
    expect(loadHistory()).toEqual([expect.objectContaining({ target: 'api', branch: 'feat/export' })]);
    expect(launchAi).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ initialPrompt: expect.stringContaining("@ana's branch: what you commit and push lands in their PR") }),
      expect.anything(),
    );
  });

  it('a number is looked up in the target; your own --prompt wins over the default one', async () => {
    await tree({ pr: '12', target: 'api', prompt: 'fix the tests' });
    expect(lookup.resolvePrToStart).toHaveBeenCalledWith('12', expect.anything(), 'api');
    expect(launchAi).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ initialPrompt: 'fix the tests' }),
      expect.anything(),
    );
  });

  it('refuses a branch, --here or --base beside it, and says why a lookup failed', async () => {
    await tree({ pr: '12', target: 'api', branch: 'feat/mine' });
    await tree({ pr: '12', here: true });
    await tree({ pr: '12', target: 'api', base: 'dev' });
    expect(errors.filter((e) => e.includes("--pr takes the PR's own branch"))).toHaveLength(3);
    expect(lookup.resolvePrToStart).not.toHaveBeenCalled();
    lookup.resolvePrToStart.mockResolvedValue({ ok: false, error: 'PR #12 comes from a fork (x)' });
    await tree({ pr: '12', target: 'api' });
    expect(errors).toContain('PR #12 comes from a fork (x)');
    expect(process.exitCode).toBe(1);
    expect(loadHistory()).toEqual([]);
    expect(launchAi).not.toHaveBeenCalled();
  });
});
