import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ input: [] as string[], confirm: [] as boolean[], select: [] as string[], checkbox: [] as string[][] }));
const asked = vi.hoisted(() => ({
  checkbox: [] as Array<{ message: string; choices: Array<{ value: string }> }>,
  refused: [] as string[],
}));
vi.mock('@inquirer/prompts', () => ({
  // As inquirer does: an answer its validate refuses is said, and the question asked again.
  input: async (o: { default?: string; validate?: (v: string) => true | string }) => {
    for (let tries = 0; tries < 5; tries++) {
      const v = answers.input.shift() ?? o.default ?? '';
      const ok = o.validate ? o.validate(v) : true;
      if (ok === true) return v;
      asked.refused.push(ok);
    }
    throw new Error('asked five times');
  },
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
  asked.refused.length = 0;
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

  it('a worktrees folder that cannot be made is refused as it is typed, and asked again; ~ is the home folder', async () => {
    // Reported: /Users/worktrees on a Mac, taken untried, failed at the first worktree. A file where a
    // folder should be can't be made on any OS.
    fs.writeFileSync(path.join(home, 'blocker'), 'a file');
    answers.input = [path.join(home, 'blocker', 'wt'), 'worktrees', '~/wt'];
    answers.checkbox = [[]];
    answers.confirm = [false, false];
    await (initCommand.handler as () => Promise<void>)();
    expect(asked.refused).toHaveLength(2);
    expect(asked.refused[0]).toContain('a file is in the way');
    expect(asked.refused[1]).toContain("isn't a full path");
    expect(loadConfig()!.worktreesRoot).toBe(path.join(home, 'wt'));
    expect(fs.statSync(path.join(home, 'wt')).isDirectory()).toBe(true);
  });
});
