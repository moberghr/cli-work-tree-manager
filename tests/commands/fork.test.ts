import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { findSession, loadHistory, upsertSession } from '../../src/core/history.js';

const h = vi.hoisted(() => ({ attach: vi.fn(async () => 0), start: vi.fn(async () => 'started') }));
vi.mock('../../src/commands/shared/attach-session.js', () => ({ attachSession: h.attach }));
vi.mock('../../src/core/worktree-routes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/worktree-routes.js')>()),
  startSessionWithPrompt: h.start,
}));

let homeDir: string;
let wt: string;
let repo: string;
const errors: string[] = [];

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-fork-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-fork-proj-')));
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  errors.length = 0;
  h.attach.mockClear();
  h.start.mockClear();
  repo = path.join(project, 'repo');
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
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
  git(['add', '.'], wt);
  git(['commit', '-m', 'x', '--no-gpg-sign'], wt);
  await upsertSession('repo', false, 'feat/x', [wt]);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const run = async (argv: Record<string, unknown>) => {
  const { forkCommand } = await import('../../src/commands/fork.js');
  await (forkCommand.handler as Function)({ _: ['fork'], attach: true, ...argv });
};

describe('work fork', () => {
  it('forks the session for this folder from its tip, and attaches this terminal to the new Claude with the fork prompt', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(wt);
    await run({ branch: 'feat/x-2', prompt: 'try it with a queue', name: 'Queue idea' });
    expect(process.exitCode ?? 0).toBe(0);
    const fork = findSession(loadHistory(), 'repo', 'feat/x-2')!;
    expect(fork.title).toBe('Queue idea');
    expect(git(['rev-parse', 'HEAD'], fork.paths[0]).stdout.trim()).toBe(git(['rev-parse', 'HEAD'], wt).stdout.trim());
    expect(h.start).not.toHaveBeenCalled();
    expect(h.attach).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/x-2' }), expect.objectContaining({ initialPrompt: expect.stringMatching(/a fork of "repo · feat\/x"[\s\S]*try it with a queue$/), forwardEnv: true }));
  });

  it('--no-attach starts it in the PTY host and returns; --target/--from name the session', async () => {
    await run({ branch: 'feat/x-3', target: 'repo', from: 'feat/x', attach: false });
    expect(h.start).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('wait for my instruction'));
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('refuses with the reason: outside a session, a taken name, half of --target/--from', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(homeDir);
    await run({ branch: 'feat/y' });
    cwd.mockRestore();
    expect(errors.join('\n')).toContain('not inside a work session');
    process.exitCode = 0;
    await run({ branch: 'main', target: 'repo', from: 'feat/x' });
    expect(errors.join('\n')).toContain('Not forked: main already exists');
    await run({ branch: 'feat/z', target: 'repo' });
    expect(errors.join('\n')).toContain('Give both --target and --from');
    expect(process.exitCode).toBe(1);
  });
});
