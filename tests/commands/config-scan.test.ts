import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, loadConfig } from '../../src/core/platform/config.js';

vi.mock('../../src/core/agents/group-instructions.js', () => ({ generateGroupInstructions: vi.fn() }));
import { configCommand } from '../../src/commands/config.js';

let tmp: string;
let out: string[];
const run = (action: string, extra: string[], json = false) =>
  (configCommand.handler as (argv: unknown) => Promise<void>)({ action, json, _: ['config', ...extra] });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-scan-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  process.exitCode = undefined;
  for (const r of ['api', 'web']) fs.mkdirSync(path.join(tmp, 'src', r, '.git'), { recursive: true });
  saveConfig({
    worktreesRoot: path.join(tmp, 'src', 'worktrees'),
    repos: { api: path.join(tmp, 'src', 'api') },
    groups: {},
    copyFiles: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('work config scan', () => {
  it('lists what is not enrolled, with the command to add it', async () => {
    await run('scan', []);
    const text = out.join('\n');
    expect(text).toContain('Not enrolled (1)');
    expect(text).toContain(`work config add web "${path.join(tmp, 'src', 'web')}"`);
    expect(text).toContain('1 enrolled · 0 ignored');
  });

  it('--json is the Repos page’s inventory', async () => {
    await run('scan', [], true);
    const inv = JSON.parse(out.join('\n')) as { repos: Array<{ folder: string; status: string }> };
    expect(inv.repos.map((r) => `${r.folder}:${r.status}`)).toEqual(['api:enrolled', 'web:new']);
  });
});

describe('work config add, by the same rules', () => {
  it('adds a repo, and refuses an alias that is taken instead of overwriting it', async () => {
    await run('add', ['web', path.join(tmp, 'src', 'web')]);
    expect(loadConfig()!.repos.web).toBe(path.join(tmp, 'src', 'web'));
    await run('add', ['api', path.join(tmp, 'src', 'web')]);
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/already the alias/);
    expect(loadConfig()!.repos.api).toBe(path.join(tmp, 'src', 'api'));
  });
});
