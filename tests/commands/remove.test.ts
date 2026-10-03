import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { loadHistory, upsertSession } from '../../src/core/history.js';
import { recordStatusEvent } from '../../src/core/session-status.js';
import { sessionIdFor } from '../../src/core/session-id.js';

vi.mock('../../src/core/pty-pool.js', () => ({ stopSessionPty: async () => {} }));

let homeDir: string;
let wt: string;
const errors: string[] = [];

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-remove-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-remove-proj-')));
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  errors.length = 0;
  const repo = path.join(project, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  const config: WorkConfig = { worktreesRoot: path.join(project, 'worktrees'), repos: { repo }, groups: {}, copyFiles: [] };
  saveConfig(config);
  wt = path.join(config.worktreesRoot, 'repo', 'feat-x');
  expect(createSingleWorktree(repo, wt, 'feat/x', config)).toBe(true);
  await upsertSession('repo', false, 'feat/x', [wt]);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const run = async (force = false) => {
  const { removeCommand } = await import('../../src/commands/remove.js');
  await (removeCommand.handler as (argv: unknown) => unknown)({ _: ['remove'], target: 'repo', branch: 'feat/x', force });
};

describe('work remove', () => {
  it("refuses while the session's Claude is working — like the dashboard's delete — and --force goes ahead", async () => {
    await recordStatusEvent(sessionIdFor({ target: 'repo', branch: 'feat/x' }), { kind: 'prompt', prompt: 'go' });
    await run();
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Not removed: its Claude is working.');
    expect(fs.existsSync(wt)).toBe(true);
    expect(loadHistory()).toHaveLength(1);
    process.exitCode = 0;
    await run(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(loadHistory()).toHaveLength(0);
  });

  it('a session with nothing waiting is removed as before', async () => {
    await run();
    expect(fs.existsSync(wt)).toBe(false);
  });
});
