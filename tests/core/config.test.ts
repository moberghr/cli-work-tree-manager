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
