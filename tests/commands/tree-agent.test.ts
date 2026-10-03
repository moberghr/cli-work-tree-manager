import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `work tree --no-host`: the direct launch runs the session's own agent, and asks that agent whether it can resume. */

vi.mock('../../src/core/platform/launch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/platform/launch.js')>()),
  launchAi: vi.fn(),
}));
const { launchAi } = await import('../../src/core/platform/launch.js');
const { git } = await import('../../src/core/git/git.js');
const { saveConfig } = await import('../../src/core/platform/config.js');
const { loadHistory, saveHistory } = await import('../../src/core/sessions/history.js');
const { treeCommand } = await import('../../src/commands/tree.js');

let home: string;
let repo: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-agent-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const tree = () =>
  (treeCommand.handler as (argv: unknown) => unknown)({
    _: [],
    target: 'api',
    branch: 'feat/x',
    host: false,
    pull: false,
    unsafe: false,
    fresh: false,
  });

describe('work tree --no-host', () => {
  it('a new session runs the default agent; coming back after the default changed, it runs the one it was created with', async () => {
    await tree();
    expect(launchAi).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ cmd: 'claude' }),
      expect.objectContaining({ resume: false }),
      expect.anything(),
    );
    expect(loadHistory()[0].agent).toBe('claude');
    // The default changes to a tool work has no adapter for.
    saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [], aiCommand: 'opencode' });
    await tree();
    expect(launchAi).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ cmd: 'claude' }),
      expect.anything(),
      expect.anything(),
    );
    // A session from before (nothing recorded) follows the default.
    saveHistory(loadHistory().map(({ agent: _a, ...s }) => s));
    await tree();
    expect(launchAi).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ cmd: 'opencode' }),
      expect.objectContaining({ resume: false }),
      expect.anything(),
    );
  });
});
