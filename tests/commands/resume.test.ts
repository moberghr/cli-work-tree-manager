import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, type WorkConfig } from '../../src/core/platform/config.js';
import { saveHistory, loadHistory, type WorktreeSession } from '../../src/core/sessions/history.js';

// Mock interactive prompt and AI launcher
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
vi.mock('../../src/core/platform/launch.js', () => ({
  launchAi: vi.fn(),
}));

import { resumeCommand } from '../../src/commands/resume.js';
import { recentCommand } from '../../src/commands/recent.js';
import { select } from '@inquirer/prompts';
import { launchAi } from '../../src/core/platform/launch.js';

let tmpDir: string;
let worktreePath: string;

const OLD_TIMESTAMP = '2025-01-01T00:00:00.000Z';

function seedConfig(): void {
  const config: WorkConfig = {
    worktreesRoot: '/tmp/wt',
    repos: { api: '/repos/api' },
    groups: {},
    copyFiles: [],
  };
  saveConfig(config);
}

function seedHistory(sessions: WorktreeSession[]): void {
  saveHistory(sessions);
}

function makeSession(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    target: 'api',
    isGroup: false,
    branch: 'feature/test',
    paths: [worktreePath],
    createdAt: OLD_TIMESTAMP,
    lastAccessedAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** Write a fake Claude transcript for a cwd under the mocked ~/.claude/projects
 *  so resolveResumeLaunch sees a resumable conversation (resume: true). */
function seedTranscript(cwd: string): void {
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(tmpDir, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), '{}\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-'));
  worktreePath = path.join(tmpDir, 'fake-worktree');
  fs.mkdirSync(worktreePath, { recursive: true });

  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('the session’s own agent', () => {
  it('work resume / work recent launch the agent a session was created with; one with no adapter never gets --continue', async () => {
    vi.mocked(launchAi).mockClear();
    // The default is now opencode; this session was created with Claude.
    saveConfig({ worktreesRoot: '/tmp/wt', repos: { api: '/repos/api' }, groups: {}, copyFiles: [], aiCommand: 'opencode' });
    const claudes = makeSession({ agent: 'claude' });
    seedHistory([claudes]);
    seedTranscript(worktreePath);
    vi.mocked(select).mockResolvedValueOnce(claudes);
    await (resumeCommand.handler as (argv: unknown) => unknown)({ unsafe: false, _: [] });
    expect(launchAi).toHaveBeenLastCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false, resume: true },
      undefined,
    );
    // One from before (nothing recorded) follows the default: opencode, and no --continue (a Claude transcript says nothing about it).
    const old = makeSession();
    seedHistory([old]);
    vi.mocked(select).mockResolvedValueOnce(old);
    await (recentCommand.handler as (argv: unknown) => unknown)({ count: 10, resume: true, unsafe: false, _: [] });
    expect(launchAi).toHaveBeenCalledTimes(2);
    expect(launchAi).toHaveBeenLastCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'opencode' }),
      { unsafe: false, resume: false },
      undefined,
    );
  });
});

describe('resume updates lastAccessedAt', () => {
  it('updates lastAccessedAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);
    seedTranscript(worktreePath); // existing conversation → resume: true

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as (argv: unknown) => unknown)({ unsafe: false, _: [] });

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].lastAccessedAt).not.toBe(OLD_TIMESTAMP);
    expect(new Date(history[0].lastAccessedAt).getTime()).toBeGreaterThan(new Date(OLD_TIMESTAMP).getTime());
    expect(launchAi).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false, resume: true },
      undefined, // no port on this session
    );
  });

  it('passes the session port to launchAi as $PORT', async () => {
    seedConfig();
    const session = makeSession({ port: 3042 });
    seedHistory([session]);
    seedTranscript(worktreePath);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as (argv: unknown) => unknown)({ unsafe: false, _: [] });

    expect(launchAi).toHaveBeenCalledWith(worktreePath, expect.objectContaining({ cmd: 'claude' }), { unsafe: false, resume: true }, 3042);
  });

  it('starts a fresh session (resume: false) when no transcript exists', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);
    // No seedTranscript — Claude was never used in this worktree.

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as (argv: unknown) => unknown)({ unsafe: false, _: [] });

    expect(launchAi).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false, resume: false },
      undefined,
    );
  });

  it('preserves createdAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as (argv: unknown) => unknown)({ unsafe: false, _: [] });

    const history = loadHistory();
    expect(history[0].createdAt).toBe(OLD_TIMESTAMP);
  });
});

describe('recent --resume updates lastAccessedAt', () => {
  it('updates lastAccessedAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);
    seedTranscript(worktreePath);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (recentCommand.handler as (argv: unknown) => unknown)({
      count: 10,
      resume: true,
      unsafe: false,
      _: [],
    });

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].lastAccessedAt).not.toBe(OLD_TIMESTAMP);
    expect(new Date(history[0].lastAccessedAt).getTime()).toBeGreaterThan(new Date(OLD_TIMESTAMP).getTime());
    expect(launchAi).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false, resume: true },
      undefined, // no port on this session
    );
  });
});
