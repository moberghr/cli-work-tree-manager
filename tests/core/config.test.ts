import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, getConfigDir, type WorkConfig } from '../../src/core/config.js';

let tmpDir: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-'));
  // Override homedir so getConfigDir uses our temp dir
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getConfigDir', () => {
  it('creates .work directory if missing', () => {
    const dir = getConfigDir();
    expect(dir).toBe(path.join(tmpDir, '.work'));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('returns existing .work directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.work'));
    const dir = getConfigDir();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('loadConfig', () => {
  it('returns null when no config file exists', () => {
    expect(loadConfig()).toBeNull();
  });

  it('loads and parses valid config', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });

    const data: WorkConfig = {
      worktreesRoot: '/tmp/wt',
      repos: { api: '/repos/api' },
      groups: { full: ['api'] },
      copyFiles: ['*.json'],
      statusHooks: [],
    };
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(data));

    const loaded = loadConfig();
    // notifications is coerced to a real boolean (opt-in, default off).
    expect(loaded).toEqual({ ...data, notifications: false });
  });

  it('loads the opt-in notifications flag', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', notifications: true }),
    );
    expect(loadConfig()?.notifications).toBe(true);
  });

  it('coerces notifications to false when absent (opt-in default off)', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt' }),
    );
    expect(loadConfig()?.notifications).toBe(false);
  });

  it('coerces a truthy non-boolean notifications value to false (only true enables)', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', notifications: 'yes' }),
    );
    const loaded = loadConfig();
    expect(loaded?.notifications).toBe(false);
    expect(typeof loaded?.notifications).toBe('boolean');
  });

  it('coerces notifications: 1 to a real boolean false', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', notifications: 1 }),
    );
    expect(loadConfig()?.notifications).toBe(false);
  });

  it('returns null for invalid JSON', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{bad json');

    expect(loadConfig()).toBeNull();
  });

  it('fills in missing fields with defaults', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt' }),
    );

    const loaded = loadConfig();
    expect(loaded).toEqual({
      worktreesRoot: '/wt',
      repos: {},
      groups: {},
      copyFiles: [],
      // notifications is coerced to a real boolean (opt-in, default off).
      notifications: false,
      statusHooks: [],
    });
  });

  it('preserves a valid statusHooks array', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        worktreesRoot: '/wt',
        statusHooks: [{ on: 'idle', command: 'beep' }],
      }),
    );
    expect(loadConfig()?.statusHooks).toEqual([{ on: 'idle', command: 'beep' }]);
  });

  it('coerces a non-array statusHooks value to an empty array', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', statusHooks: { on: 'idle' } }),
    );
    const loaded = loadConfig();
    expect(loaded?.statusHooks).toEqual([]);
    expect(Array.isArray(loaded?.statusHooks)).toBe(true);
  });
});

describe('saveConfig', () => {
  it('writes config as formatted JSON', () => {
    const data: WorkConfig = {
      worktreesRoot: '/tmp/wt',
      repos: { api: '/repos/api' },
      groups: {},
      copyFiles: [],
    };

    saveConfig(data);

    const configPath = path.join(tmpDir, '.work', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(data);
    // Verify it's pretty-printed
    expect(raw).toContain('\n');
  });

  it('overwrites existing config', () => {
    const first: WorkConfig = {
      worktreesRoot: '/first',
      repos: {},
      groups: {},
      copyFiles: [],
    };
    const second: WorkConfig = {
      worktreesRoot: '/second',
      repos: { x: '/x' },
      groups: {},
      copyFiles: [],
    };

    saveConfig(first);
    saveConfig(second);

    const loaded = loadConfig();
    expect(loaded?.worktreesRoot).toBe('/second');
    expect(loaded?.repos).toEqual({ x: '/x' });
  });
});
