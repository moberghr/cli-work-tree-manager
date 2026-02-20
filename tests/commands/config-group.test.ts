import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, loadConfig, type WorkConfig } from '../../src/core/config.js';

// Mock generateGroupClaudeMd before importing the config command
vi.mock('../../src/core/claude-md.js', () => ({
  generateGroupClaudeMd: vi.fn(),
}));

import { configCommand } from '../../src/commands/config.js';
import { generateGroupClaudeMd } from '../../src/core/claude-md.js';

let tmpDir: string;

function seedConfig(overrides: Partial<WorkConfig> = {}): WorkConfig {
  const config: WorkConfig = {
    worktreesRoot: '/tmp/wt',
    repos: { api: '/repos/api', web: '/repos/web', shared: '/repos/shared' },
    groups: {},
    copyFiles: [],
    ...overrides,
  };
  saveConfig(config);
  return config;
}

function run(...extra: string[]): void {
  const argv = {
    action: 'group',
    _: ['config', ...extra],
  };
  (configCommand.handler as Function)(argv);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-'));
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

// ─── config group add ────────────────────────────────────────────

describe('config group add', () => {
  it('creates a group with valid aliases', () => {
    seedConfig();
    run('add', 'fullstack', 'api', 'web');

    const config = loadConfig()!;
    expect(config.groups.fullstack).toEqual(['api', 'web']);
    expect(process.exitCode).toBeUndefined();
    expect(generateGroupClaudeMd).toHaveBeenCalledWith(
      'fullstack',
      ['api', 'web'],
      expect.objectContaining({ repos: expect.any(Object) }),
    );
  });

  it('rejects when no group name is given', () => {
    seedConfig();
    run('add');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage:'),
    );
  });

  it('rejects when fewer than 2 aliases are given', () => {
    seedConfig();
    run('add', 'mygroup', 'api');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('at least 2'),
    );
    const config = loadConfig()!;
    expect(config.groups.mygroup).toBeUndefined();
  });

  it('rejects when an alias does not exist', () => {
    seedConfig();
    run('add', 'mygroup', 'api', 'nonexistent');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent'),
    );
    const config = loadConfig()!;
    expect(config.groups.mygroup).toBeUndefined();
  });

  it('rejects when group name collides with a repo alias', () => {
    seedConfig();
    run('add', 'api', 'web', 'shared');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('conflicts with an existing repository alias'),
    );
  });

  it('rejects when group name collides with a repo folder name', () => {
    seedConfig({ repos: { myalias: '/repos/fullstack' } });
    run('add', 'fullstack', 'myalias', 'myalias');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('conflicts with a repository folder name'),
    );
  });

  it('overwrites an existing group', () => {
    seedConfig({ groups: { fullstack: ['api', 'web'] } });
    run('add', 'fullstack', 'api', 'shared');

    const config = loadConfig()!;
    expect(config.groups.fullstack).toEqual(['api', 'shared']);
    expect(process.exitCode).toBeUndefined();
  });
});

// ─── config group remove ─────────────────────────────────────────

describe('config group remove', () => {
  it('removes an existing group', () => {
    seedConfig({ groups: { fullstack: ['api', 'web'] } });
    run('remove', 'fullstack');

    const config = loadConfig()!;
    expect(config.groups.fullstack).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it('deletes the group claude.md file', () => {
    seedConfig({ groups: { fullstack: ['api', 'web'] } });
    const claudeMdPath = path.join(tmpDir, '.work', 'fullstack.claude.md');
    fs.writeFileSync(claudeMdPath, '# test');

    run('remove', 'fullstack');

    expect(fs.existsSync(claudeMdPath)).toBe(false);
  });

  it('succeeds even when no claude.md file exists', () => {
    seedConfig({ groups: { fullstack: ['api', 'web'] } });
    run('remove', 'fullstack');

    expect(process.exitCode).toBeUndefined();
    const config = loadConfig()!;
    expect(config.groups.fullstack).toBeUndefined();
  });

  it('rejects when no group name is given', () => {
    seedConfig();
    run('remove');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage:'),
    );
  });

  it('rejects when group does not exist', () => {
    seedConfig();
    run('remove', 'nonexistent');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Group not found'),
    );
  });
});

// ─── config group regen ──────────────────────────────────────────

describe('config group regen', () => {
  it('calls generateGroupClaudeMd for an existing group', () => {
    seedConfig({ groups: { fullstack: ['api', 'web'] } });
    run('regen', 'fullstack');

    expect(process.exitCode).toBeUndefined();
    expect(generateGroupClaudeMd).toHaveBeenCalledWith(
      'fullstack',
      ['api', 'web'],
      expect.objectContaining({ groups: { fullstack: ['api', 'web'] } }),
    );
  });

  it('rejects when no group name is given', () => {
    seedConfig();
    run('regen');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage:'),
    );
  });

  it('rejects when group does not exist', () => {
    seedConfig();
    run('regen', 'nonexistent');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Group not found'),
    );
  });
});

// ─── config group (no sub-action) ────────────────────────────────

describe('config group (dispatcher)', () => {
  it('shows group help when no sub-action is given', () => {
    seedConfig();
    run();

    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('config group'),
    );
  });

  it('shows group help for an unknown sub-action', () => {
    seedConfig();
    run('bogus');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('config group'),
    );
  });
});
