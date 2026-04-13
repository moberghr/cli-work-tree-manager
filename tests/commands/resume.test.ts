import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { saveHistory, loadHistory, type WorktreeSession } from '../../src/core/history.js';

// Mock interactive prompt and AI launcher
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
vi.mock('../../src/utils/platform.js', () => ({
  launchAi: vi.fn(),
}));

import { resumeCommand } from '../../src/commands/resume.js';
import { recentCommand } from '../../src/commands/recent.js';
import { select } from '@inquirer/prompts';
import { launchAi } from '../../src/utils/platform.js';

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

describe('resume updates lastAccessedAt', () => {
  it('updates lastAccessedAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as Function)({ unsafe: false, _: [] });

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].lastAccessedAt).not.toBe(OLD_TIMESTAMP);
    expect(new Date(history[0].lastAccessedAt).getTime()).toBeGreaterThan(
      new Date(OLD_TIMESTAMP).getTime(),
    );
    expect(launchAi).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false },
    );
  });

  it('preserves createdAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (resumeCommand.handler as Function)({ unsafe: false, _: [] });

    const history = loadHistory();
    expect(history[0].createdAt).toBe(OLD_TIMESTAMP);
  });
});

describe('recent --resume updates lastAccessedAt', () => {
  it('updates lastAccessedAt when resuming', async () => {
    seedConfig();
    const session = makeSession();
    seedHistory([session]);

    vi.mocked(select).mockResolvedValueOnce(session);

    await (recentCommand.handler as Function)({
      count: 10,
      resume: true,
      unsafe: false,
      _: [],
    });

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].lastAccessedAt).not.toBe(OLD_TIMESTAMP);
    expect(new Date(history[0].lastAccessedAt).getTime()).toBeGreaterThan(
      new Date(OLD_TIMESTAMP).getTime(),
    );
    expect(launchAi).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ cmd: 'claude' }),
      { unsafe: false },
    );
  });
});
