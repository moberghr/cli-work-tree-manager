import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  installCommandHook,
  removeCommandHook,
  removeCommandHookSync,
} from '../../../src/core/platform/command-hook-installer.js';

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cmd-hook-test-'));
  fs.mkdirSync(path.join(tmpDir, '.claude'));
  settingsFile = path.join(tmpDir, '.claude', 'settings.json');
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Entry = { hooks: Array<{ type: string; command: string; timeout?: number }>; [k: string]: unknown };
const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { hooks?: Record<string, Entry[]>; [k: string]: unknown };
const write = (s: unknown) => fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
const commands = (event: string) => (read().hooks?.[event] ?? []).map((e) => e.hooks[0].command);

/** A pid that certainly belongs to no running process. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid!;
}

const userHook: Entry = { matcher: '', hooks: [{ type: 'command', command: 'my-own-linter' }] };

describe('installCommandHook', () => {
  it('adds a tagged entry and keeps everything the user had', async () => {
    write({ theme: 'dark', hooks: { UserPromptSubmit: [userHook], Stop: [userHook] } });
    await installCommandHook({ owner: 'web-status', event: 'UserPromptSubmit', command: 'work hook status-prompt' });

    const s = read();
    expect(s.theme).toBe('dark');
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter', 'work hook status-prompt']);
    expect(commands('Stop')).toEqual(['my-own-linter']);
    const ours = s.hooks!.UserPromptSubmit[1];
    expect(ours._workHookOwner).toBe('web-status');
    expect(ours._workHookPid).toBe(process.pid);
    expect(ours.hooks[0]).toEqual({ type: 'command', command: 'work hook status-prompt', timeout: 5 });
  });

  it('creates settings.json when there is none', async () => {
    await installCommandHook({ owner: 'o', event: 'Stop', command: 'work hook stop', timeoutSec: 30 });
    expect(read().hooks!.Stop[0].hooks[0].timeout).toBe(30);
  });

  it('re-installing replaces its own entry instead of piling up', async () => {
    await installCommandHook({ owner: 'o', event: 'Stop', command: 'work hook stop' });
    await installCommandHook({ owner: 'o', event: 'Stop', command: 'work hook stop --v2' });
    expect(commands('Stop')).toEqual(['work hook stop --v2']);
  });

  it("leaves other live owners' entries alone and prunes ones whose process is gone", async () => {
    write({
      hooks: {
        Stop: [
          userHook,
          { hooks: [{ type: 'command', command: 'live other' }], _workHookOwner: 'web-checkpoint', _workHookPid: process.pid },
          { hooks: [{ type: 'command', command: 'crashed run' }], _workHookOwner: 'web-checkpoint', _workHookPid: deadPid() },
          // Untagged / owner-only entries are never treated as stale.
          { hooks: [{ type: 'command', command: 'no pid' }], _workHookOwner: 'legacy' },
        ],
      },
    });
    await installCommandHook({ owner: 'web-status', event: 'Stop', command: 'work hook status-stop' });
    expect(commands('Stop')).toEqual(['my-own-linter', 'live other', 'no pid', 'work hook status-stop']);
  });
});

describe('removeCommandHook', () => {
  it('removes only its own entries for that event, and drops an emptied event', async () => {
    await installCommandHook({ owner: 'a', event: 'Stop', command: 'a-stop' });
    await installCommandHook({ owner: 'b', event: 'Stop', command: 'b-stop' });
    await installCommandHook({ owner: 'a', event: 'Notification', command: 'a-notify' });

    await removeCommandHook('a', 'Stop');
    expect(commands('Stop')).toEqual(['b-stop']);
    expect(commands('Notification')).toEqual(['a-notify']);

    await removeCommandHook('a', 'Notification');
    expect(read().hooks).not.toHaveProperty('Notification');
  });

  it('the sync variant (signal handlers) does the same', async () => {
    write({ hooks: { Stop: [userHook] } });
    await installCommandHook({ owner: 'a', event: 'Stop', command: 'a-stop' });
    removeCommandHookSync('a', 'Stop');
    expect(commands('Stop')).toEqual(['my-own-linter']);
  });

  it('is a no-op when there is nothing to remove', async () => {
    write({ hooks: { Stop: [userHook] } });
    await removeCommandHook('a', 'UserPromptSubmit');
    removeCommandHookSync('a', 'Stop');
    expect(read()).toEqual({ hooks: { Stop: [userHook] } });
  });
});

describe('syncCommandHooks (work web, one write)', () => {
  it('the full set replaces the old separate hooks, keeps the user’s own, and removes cleanly', async () => {
    const { FULL_HOOKS, LEGACY_HOOKS } = await import('../../../src/commands/web.js');
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js'); // work's hooks in Claude's settings: its adapter's install
    write({ hooks: { UserPromptSubmit: [userHook] } });
    // What an older work web left (three per event):
    for (const [owner, event, command] of [
      ['web', 'UserPromptSubmit', 'work hook prompt-submit'],
      ['web-status', 'UserPromptSubmit', 'work hook status-prompt'],
      ['web-checkpoint', 'UserPromptSubmit', 'work hook checkpoint-seal'],
      ['web', 'Stop', 'work hook stop'],
      ['web-status', 'Stop', 'work hook status-stop'],
      ['web-checkpoint', 'Stop', 'work hook checkpoint'],
    ]) await installCommandHook({ owner, event, command });
    const writes = vi.spyOn(fs, 'renameSync');
    await claudeAgent.events!.install(FULL_HOOKS, LEGACY_HOOKS);
    expect(writes).toHaveBeenCalledTimes(1); // one write, not one per hook
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter', 'work hook turn-start']);
    expect(commands('Stop')).toEqual(['work hook turn-end']);
    expect(commands('Notification')).toEqual(['work hook status-notify']);
    claudeAgent.events!.removeSync([...FULL_HOOKS.map(({ owner, edge }) => ({ owner, edge })), ...LEGACY_HOOKS]);
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter']);
    expect(read().hooks?.Stop).toBeUndefined();
  });
});

describe('untagged copies of work’s hooks (tags dropped by another writer of settings.json)', () => {
  it('are replaced on install and removed on shutdown; the user’s own hooks — even ones calling work — stay', async () => {
    const { FULL_HOOKS, LEGACY_HOOKS } = await import('../../../src/commands/web.js');
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js'); // work's hooks in Claude's settings: its adapter's install
    const bare = (command: string, timeout = 5): Entry => ({ hooks: [{ type: 'command', command, timeout }] });
    write({
      hooks: {
        UserPromptSubmit: [userHook, bare('work hook prompt-submit', 15), bare('work hook checkpoint-seal'), bare('work hook checkpoint-seal')],
        Stop: [bare('work hook checkpoint', 15), { hooks: [{ type: 'command', command: 'work hook checkpoint && my-script' }] }],
      },
    });
    await claudeAgent.events!.install(FULL_HOOKS, LEGACY_HOOKS);
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter', 'work hook turn-start']);
    expect(commands('Stop')).toEqual(['work hook checkpoint && my-script', 'work hook turn-end']); // not only ours: kept
    // Something rewrites settings.json and drops our tags…
    const s = read();
    for (const list of Object.values(s.hooks ?? {})) for (const e of list) for (const k of Object.keys(e)) if (k.startsWith('_work')) delete e[k];
    write(s);
    // …the next start doesn't pile a second copy on.
    await claudeAgent.events!.install(FULL_HOOKS, LEGACY_HOOKS);
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter', 'work hook turn-start']);
    claudeAgent.events!.removeSync([...FULL_HOOKS.map(({ owner, edge }) => ({ owner, edge })), ...LEGACY_HOOKS]);
    expect(commands('UserPromptSubmit')).toEqual(['my-own-linter']);
    expect(commands('Stop')).toEqual(['work hook checkpoint && my-script']);
  });
});
