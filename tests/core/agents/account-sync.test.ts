import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAccountSync } from '../../../src/core/agents/account-sync.js';

describe('startAccountSync', () => {
  afterEach(() => vi.useRealTimers());

  it('runs the setup only when the set of folders changes (order and repeats do not count)', async () => {
    let folders = ['/a', '/b'];
    const apply = vi.fn(async () => {});
    const sync = startAccountSync({ folders: () => folders, apply, everyMs: 0 });
    expect(await sync.check()).toBe(false);
    folders = ['/b', '/a', '/a'];
    expect(await sync.check()).toBe(false);
    folders = ['/a', '/b', '/c'];
    expect(await sync.check()).toBe(true);
    expect(await sync.check()).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('looks by itself every few seconds, until stopped', async () => {
    vi.useFakeTimers();
    let folders = ['/a'];
    const apply = vi.fn(async () => {});
    const sync = startAccountSync({ folders: () => folders, apply, everyMs: 1000 });
    folders = ['/a', '/new'];
    await vi.advanceTimersByTimeAsync(1000);
    expect(apply).toHaveBeenCalledTimes(1);
    sync.stop();
    folders = ['/a'];
    await vi.advanceTimersByTimeAsync(5000);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a run that fails is said once (not every look), and the next change runs it again', async () => {
    let folders = ['/a'];
    const errors: unknown[] = [];
    const apply = vi.fn(async () => {
      throw new Error('settings locked');
    });
    const sync = startAccountSync({ folders: () => folders, apply, onError: (e) => errors.push(e), everyMs: 0 });
    folders = ['/a', '/b'];
    expect(await sync.check()).toBe(false);
    expect(await sync.check()).toBe(false);
    expect(errors).toHaveLength(1);
    folders = ['/a', '/b', '/c'];
    await sync.check();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('one run at a time: a look while one runs does nothing', async () => {
    let folders = ['/a'];
    let release!: () => void;
    const apply = vi.fn(() => new Promise<void>((r) => (release = r)));
    const sync = startAccountSync({ folders: () => folders, apply, everyMs: 0 });
    folders = ['/a', '/b'];
    const first = sync.check();
    expect(await sync.check()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('work web: an account added while it runs gets the hooks and the status line (the wiring)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-sync-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.mkdirSync(path.join(tmp, '.work'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const writeConfig = async (extra: Record<string, unknown> = {}) => {
    const { getConfigPath } = await import('../../../src/core/platform/config.js');
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ worktreesRoot: path.join(tmp, 'wt'), repos: {}, groups: {}, copyFiles: [], ...extra }),
    );
  };

  it('the folders follow config, and a check after `work account add` installs both in the new folder', async () => {
    await writeConfig();
    const { agentAccountFolders, agentById } = await import('../../../src/core/agents/index.js');
    const { installAgentHooks, startAccountSetupSync } = await import('../../../src/commands/web.js');
    await installAgentHooks(false);
    expect(agentAccountFolders()).toEqual([path.join(tmp, '.claude')]);
    // The one work web starts (startAccountSetupSync), with the real apply: hooks and status line again.
    const sync = startAccountSetupSync(false, { everyMs: 0 });

    const dir = await agentById('claude').accounts!.admin!.add('work', path.join(tmp, 'acc-work'));
    expect(agentAccountFolders()).toEqual([path.join(tmp, '.claude'), dir]);
    expect(await sync.check()).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine?: { command?: string };
    };
    expect(settings.hooks?.Stop?.map((e) => e.hooks[0].command)).toEqual(['work hook turn-end']);
    expect(settings.statusLine?.command).toContain('hook statusline');
    sync.stop();
  });

  it('an account whose folder is not there yet counts once the folder appears (nothing is made before)', async () => {
    const later = path.join(tmp, 'acc-later');
    await writeConfig({ claudeAccounts: { later } });
    const { startAccountSetupSync } = await import('../../../src/commands/web.js');
    const apply = vi.fn(async () => {});
    const sync = startAccountSetupSync(false, { apply, everyMs: 0 });
    expect(await sync.check()).toBe(false);
    expect(fs.existsSync(later)).toBe(false);
    fs.mkdirSync(later);
    expect(await sync.check()).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    sync.stop();
  });
});
