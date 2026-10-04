import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ input: [] as string[], confirm: [] as boolean[], select: [] as string[], checkbox: [] as string[][] }));
const asked = vi.hoisted(() => ({ checkbox: [] as Array<{ message: string; choices: Array<{ value: string }> }> }));
vi.mock('@inquirer/prompts', () => ({
  input: async (o: { default?: string }) => answers.input.shift() ?? o.default ?? '',
  confirm: async () => answers.confirm.shift() ?? false,
  select: async (o: { default?: string }) => answers.select.shift() ?? o.default,
  checkbox: async (o: { message: string; choices: Array<{ value: string }> }) => (asked.checkbox.push(o), answers.checkbox.shift() ?? []),
}));
vi.mock('../../src/commands/shared/setup-completions.js', () => ({
  setupCompletions: () => [],
  printCompletionResults: () => {},
  printManualInstructions: () => {},
}));
import { initCommand } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/platform/config.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-init-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const r of ['api', 'web', 'hangfire']) fs.mkdirSync(path.join(home, 'source', 'repos', r, '.git'), { recursive: true });
  asked.checkbox.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('work init', () => {
  it('suggests the folders, scans your repos folder and enrols the ones you tick', async () => {
    const repos = path.join(home, 'source', 'repos');
    // Worktrees and repos folder: the suggestions; AI tool: the default; tick api and web; no repo by path; no completions.
    answers.input = [];
    answers.checkbox = [[path.join(repos, 'api'), path.join(repos, 'web')]];
    answers.confirm = [false, false];
    await (initCommand.handler as () => Promise<void>)();
    expect(asked.checkbox[0].message).toMatch(/Found 3 repos/);
    const c = loadConfig()!;
    expect(c.worktreesRoot).toBe(path.join(home, 'source', 'worktrees'));
    expect(c.scanRoots).toEqual([repos]);
    expect(c.repos).toEqual({ api: path.join(repos, 'api'), web: path.join(repos, 'web') });
  });
});
