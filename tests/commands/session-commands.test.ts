import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { upsertSession } from '../../src/core/history.js';
import { readSnooze } from '../../src/core/snooze-store.js';
import { readRailLayout } from '../../src/core/rail-store.js';
import { recordStatusEvent } from '../../src/core/session-status.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { snoozeCommand } from '../../src/commands/snooze.js';
import { pinCommand } from '../../src/commands/pin.js';
import { sectionCommand } from '../../src/commands/section.js';
import { updateCommand } from '../../src/commands/update.js';
import { catchupCommand } from '../../src/commands/catchup.js';

/** `work snooze | pin | section | update | catchup`: the dashboard's session actions, from a terminal. */

let homeDir: string;
let wt: string;
const out: string[] = [];
const errors: string[] = [];
const id = sessionIdFor({ target: 'repo', branch: 'feat/x' });

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cmds-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-cmds-proj-')));
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  out.length = 0;
  errors.length = 0;
  const repo = path.join(project, 'repo');
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
  await upsertSession('repo', false, 'feat/x', [wt]);
  vi.spyOn(process, 'cwd').mockReturnValue(wt);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const COMMANDS: Record<string, { handler: Function }> = { snoozeCommand, pinCommand, sectionCommand, updateCommand, catchupCommand } as never;
const run = async (_file: string, name: string, argv: Record<string, unknown> = {}) => {
  await COMMANDS[name].handler({ _: [name], ...argv });
};

describe('work snooze', () => {
  it('for a while, until a time, until it changes; --off; a time that is none is refused', async () => {
    await run('snooze', 'snoozeCommand', {});
    expect(readSnooze(id)?.until).toBeTruthy(); // 2h by default
    await run('snooze', 'snoozeCommand', { until: '+3h' });
    expect(Date.parse(readSnooze(id)!.until!) - Date.now()).toBeGreaterThan(2.9 * 3600_000);
    await run('snooze', 'snoozeCommand', { for: 'change' });
    expect(readSnooze(id)).toMatchObject({ until: null });
    await run('snooze', 'snoozeCommand', { off: true });
    expect(readSnooze(id)).toBeNull();
    await run('snooze', 'snoozeCommand', { until: 'someday' });
    expect(errors.join('\n')).toContain('Not a time: someday');
    expect(process.exitCode).toBe(1);
  });

  it('outside a session, without naming one: says so', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
    await run('snooze', 'snoozeCommand', {});
    expect(errors.join('\n')).toContain('not inside a work session');
  });
});

describe('work pin / work section', () => {
  it('pins and unpins; puts it under a section (made when new), takes it out, lists them', async () => {
    await run('pin', 'pinCommand', {});
    expect(readRailLayout().places[id]).toEqual({ pinned: true });
    await run('pin', 'pinCommand', { off: true });
    expect(readRailLayout().places[id]).toBeUndefined();
    await run('section', 'sectionCommand', { to: 'Client X' });
    const layout = readRailLayout();
    expect(layout.sections.map((s) => s.name)).toEqual(['Client X']);
    expect(layout.places[id]).toEqual({ section: layout.sections[0].id });
    await run('section', 'sectionCommand', { to: 'client x' }); // the same one, any case
    expect(readRailLayout().sections).toHaveLength(1);
    out.length = 0;
    await run('section', 'sectionCommand', { list: true });
    expect(out.join('\n')).toContain('Client X');
    await run('section', 'sectionCommand', { none: true });
    expect(readRailLayout().places[id]).toBeUndefined();
  });
});

describe('work update / work catchup', () => {
  it('update: refused while its Claude works; already up to date otherwise (no origin here: says why)', async () => {
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'go' });
    await run('update', 'updateCommand', {});
    expect(errors.join('\n')).toContain('Not now: its Claude is working');
    expect(process.exitCode).toBe(1);
  });

  it('catchup with no conversation: nothing to go on', async () => {
    await run('catchup', 'catchupCommand', {});
    expect(errors.join('\n')).toContain('Nothing to go on');
    expect(process.exitCode).toBe(1);
  });
});
