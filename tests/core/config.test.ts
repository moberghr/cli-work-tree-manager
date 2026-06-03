import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, getConfigDir, validatePortRange, type WorkConfig } from '../../src/core/config.js';

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
    };
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(data));

    const loaded = loadConfig();
    expect(loaded).toEqual(data);
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
    });
  });

  it('accepts a valid portRange', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', portRange: { start: 4000, end: 4099 } }),
    );
    expect(loadConfig()?.portRange).toEqual({ start: 4000, end: 4099 });
  });

  it('drops an invalid portRange (privileged port) to undefined', () => {
    const configDir = path.join(tmpDir, '.work');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ worktreesRoot: '/wt', portRange: { start: 80, end: 4000 } }),
    );
    expect(loadConfig()?.portRange).toBeUndefined();
  });
});

describe('validatePortRange', () => {
  it('accepts an in-bounds integer range', () => {
    expect(validatePortRange({ start: 3000, end: 3099 })).toEqual({ start: 3000, end: 3099 });
  });

  it('accepts the boundary values 1024 and 65535', () => {
    expect(validatePortRange({ start: 1024, end: 65535 })).toEqual({ start: 1024, end: 65535 });
  });

  it('rejects privileged ports below 1024', () => {
    expect(validatePortRange({ start: 1023, end: 2000 })).toBeUndefined();
  });

  it('rejects ports above 65535', () => {
    expect(validatePortRange({ start: 3000, end: 70000 })).toBeUndefined();
  });

  it('rejects a reversed range (start > end)', () => {
    expect(validatePortRange({ start: 4000, end: 3000 })).toBeUndefined();
  });

  it('rejects non-integer ports', () => {
    expect(validatePortRange({ start: 3000.5, end: 3099 })).toBeUndefined();
  });

  it('rejects non-number / missing fields and non-objects', () => {
    expect(validatePortRange({ start: '3000', end: 3099 })).toBeUndefined();
    expect(validatePortRange({ start: 3000 })).toBeUndefined();
    expect(validatePortRange(null)).toBeUndefined();
    expect(validatePortRange(undefined)).toBeUndefined();
    expect(validatePortRange(42)).toBeUndefined();
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
