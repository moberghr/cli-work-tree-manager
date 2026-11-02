import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/platform/spawn.js', () => ({ default: { sync: spawnSync } }));
const callWeb = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/platform/web-discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/platform/web-discovery.js')>()),
  callWorkWeb: callWeb,
}));
const hostPtys = vi.hoisted(() => ({ list: [] as Array<{ id: string; exited: boolean }> }));
vi.mock('../../src/core/pty/pty-pool.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/pty/pty-pool.js')>()),
  listHostPtys: async () => hostPtys.list,
}));
import { accountCommand, ageText, usageText } from '../../src/commands/account.js';
import { recordReading } from '../../src/core/usage/usage-store.js';
import { accountOf } from '../../src/core/agents/claude/rate-limits.js';
import { getConfigPath, loadConfig, saveConfig } from '../../src/core/platform/config.js';
import { loadHistory, saveHistory } from '../../src/core/sessions/history.js';
import { encodeProjectDir } from '../../src/core/agents/claude/activity.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import type { WorktreeSession } from '../../src/core/sessions/session-types.js';

let home: string;
let out: string[];
const run = (argv: Record<string, unknown>) =>
  (accountCommand.handler as (a: unknown) => Promise<void>)({ _: ['account'], login: true, ...argv });
const text = () => out.join('\n');

const session = (target: string, account?: string, archivedAt?: string): WorktreeSession =>
  ({
    target,
    isGroup: false,
    branch: 'feat/x',
    paths: ['/p'],
    createdAt: 'x',
    lastAccessed: 'x',
    ...(account ? { account } : {}),
    ...(archivedAt ? { archivedAt } : {}),
  }) as unknown as WorktreeSession;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-cmd-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  process.exitCode = undefined;
  spawnSync.mockReset();
  // `claude …` answers OK (the skills install after an add runs `claude --version`, `plugin …`).
  spawnSync.mockReturnValue({ status: 0, stdout: 'moberg-plugins', stderr: '' });
  callWeb.mockReset();
  hostPtys.list = [];
  saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exitCode = undefined;
});

describe('work account', () => {
  it('add records the account, then starts claude on its folder in this terminal', async () => {
    await run({ action: 'add', name: 'work' });
    const dir = path.join(home, '.claude-work');
    expect(loadConfig()?.claudeAccounts).toEqual({ work: dir });
    const [cmd, args, opts] = spawnSync.mock.calls[0] as [
      string,
      string[],
      { stdio: string; windowsHide: boolean; env: Record<string, string> },
    ];
    expect(cmd).toBe('claude');
    expect(args).toEqual([]);
    expect(opts).toMatchObject({ stdio: 'inherit', windowsHide: false });
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(text()).toContain('/login');
  });

  it('after the login, installs work’s skills (the Claude plugin) into the new account’s folder', async () => {
    await run({ action: 'add', name: 'work' });
    const dir = path.join(home, '.claude-work');
    const calls = spawnSync.mock.calls as Array<[string, string[], { stdio?: string; env?: Record<string, string> }]>;
    expect(calls[0][2].stdio).toBe('inherit'); // the login first
    const rest = calls.slice(1);
    expect(rest.map((c) => c[1].join(' '))).toContain('plugin install work-tree@moberg-plugins --scope user');
    expect(rest.every((c) => c[0] === 'claude' && c[2].env?.CLAUDE_CONFIG_DIR === dir && c[2].stdio === 'pipe')).toBe(true);
    expect(text()).toContain('installed the Claude Code plugin');
  });

  it('add --no-login records without starting claude to log in (the skills still go in), and takes a folder', async () => {
    await run({ action: 'add', name: 'work', folder: path.join(home, 'elsewhere'), login: false });
    const calls = spawnSync.mock.calls as Array<[string, string[], { stdio?: string }]>;
    expect(calls.some((c) => c[2].stdio === 'inherit')).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(loadConfig()?.claudeAccounts).toEqual({ work: path.join(home, 'elsewhere') });
  });

  it('add refuses a reserved name without starting claude', async () => {
    await run({ action: 'add', name: 'default' });
    expect(process.exitCode).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(text()).toContain('default');
  });

  it('list --json gives name, folder, default, logged in and live sessions', async () => {
    await run({ action: 'add', name: 'work', login: false });
    fs.writeFileSync(path.join(home, '.claude-work', '.credentials.json'), '{}');
    saveHistory([session('api', 'work'), session('web'), session('old', 'work', '2026-01-01')]);
    out = [];
    await run({ action: 'list', json: true });
    const rows = JSON.parse(text()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.name)).toEqual(['default', 'work']);
    expect(rows[0]).toMatchObject({ default: true, liveSessions: 1, folder: path.join(home, '.claude') });
    expect(rows[1]).toMatchObject({ default: false, loggedIn: true, liveSessions: 1, folder: path.join(home, '.claude-work') });
  });

  it('list shows each account’s last usage reading, in text and --json (T2)', async () => {
    await run({ action: 'add', name: 'work', login: false });
    const now = Date.now();
    // The status-line hook keeps a reading per account folder: `default` for ~/.claude, a hash for another.
    recordReading(
      'claude',
      accountOf(path.join(home, '.claude-work')),
      [
        { id: 'five_hour', label: '5-hour limit', usedPercent: 42.4, resetsAt: new Date(now + 3_600_000).toISOString() },
        { id: 'seven_day', label: 'Weekly limit', usedPercent: 18, resetsAt: new Date(now + 86_400_000).toISOString() },
      ],
      now - 5 * 60_000,
    );
    out = [];
    await run({ action: 'list' });
    expect(out[0]).toContain('no usage reading yet');
    expect(out[1]).toContain('5-hour limit 42%');
    expect(out[1]).toContain('Weekly limit 18%');
    expect(out[1]).toContain('read 5 min ago');
    out = [];
    await run({ action: 'list', json: true });
    const rows = JSON.parse(text()) as Array<{
      name: string;
      usage: null | { at: string; ageMs: number; windows: Array<{ id: string; usedPercent: number }> };
    }>;
    expect(rows[0]!.usage).toBeNull();
    expect(rows[1]!.usage?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['five_hour', 42.4],
      ['seven_day', 18],
    ]);
    expect(rows[1]!.usage?.ageMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('usageText: a window whose reset has passed reads 0; the age in a few words', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const reading = {
      account: 'work',
      at: '2026-10-29T09:00:00Z',
      windows: [{ id: 'five_hour', label: '5-hour limit', usedPercent: 90, resetsAt: '2026-10-29T11:00:00Z' }],
    };
    expect(usageText(reading, now)).toBe('5-hour limit 0% · read 3 h ago');
    expect(usageText(undefined, now)).toBe('no usage reading yet');
    expect(usageText({ ...reading, windows: [] }, now)).toBe('no usage reading yet');
    expect(ageText(20_000)).toBe('just now');
    expect(ageText(3 * 86_400_000)).toBe('3 days ago');
  });

  it('list prints a line per account and marks the default', async () => {
    await run({ action: 'add', name: 'work', login: false });
    await run({ action: 'default', name: 'work' });
    out = [];
    await run({ action: 'list' });
    expect(out).toHaveLength(2);
    expect(out[0]).not.toContain('(default)');
    expect(out[1]).toContain('work');
    expect(out[1]).toContain('(default)');
  });

  it('default sets the account new sessions use, refusing an unknown one', async () => {
    await run({ action: 'add', name: 'work', login: false });
    await run({ action: 'default', name: 'work' });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')).claudeAccount).toBe('work');
    await run({ action: 'default', name: 'nope' });
    expect(process.exitCode).toBe(1);
  });

  it('remove is refused while a live session uses it, naming it — --force or not', async () => {
    await run({ action: 'add', name: 'work', login: false });
    saveHistory([session('api', 'work'), session('web')]);
    await run({ action: 'remove', name: 'work' });
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('api · feat/x');
    process.exitCode = undefined;
    await run({ action: 'remove', name: 'work', force: true });
    expect(process.exitCode).toBe(1);
    expect(loadConfig()?.claudeAccounts).toBeDefined();
  });

  it('remove is refused while archived sessions use it (their Restore would land on the default), naming them, unless --force', async () => {
    await run({ action: 'add', name: 'work', login: false });
    saveHistory([session('api', 'work', '2026-01-01'), session('web', undefined, '2026-01-01')]);
    out = [];
    await run({ action: 'remove', name: 'work' });
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('1 archived session on work');
    expect(text()).toContain('api · feat/x');
    expect(text()).not.toContain('web · feat/x');
    expect(text()).toContain('--force');
    expect(loadConfig()?.claudeAccounts).toBeDefined();
    process.exitCode = undefined;
    await run({ action: 'remove', name: 'work', force: true });
    expect(process.exitCode).toBeUndefined();
    expect(loadConfig()?.claudeAccounts).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.claude-work'))).toBe(true);
  });

  it('remove with nothing on it just goes', async () => {
    await run({ action: 'add', name: 'work', login: false });
    saveHistory([session('api')]);
    await run({ action: 'remove', name: 'work' });
    expect(process.exitCode).toBeUndefined();
    expect(loadConfig()?.claudeAccounts).toBeUndefined();
  });

  it('asks for a name when one is missing', async () => {
    await run({ action: 'remove' });
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('Usage');
  });
});

describe('work account switch', () => {
  const wt = () => path.join(home, 'wt', 'api');
  const row = () => ({ ...session('api'), paths: [wt()] }) as WorktreeSession;
  const projects = (account: string) => path.join(home, account, 'projects', encodeProjectDir(wt()));

  it('asks work web (it drives the PTY), by the session id and the account', async () => {
    saveHistory([row()]);
    callWeb.mockResolvedValue({ ok: true, body: { ok: true, outcome: 'switched', moved: 3 } });
    await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
    expect(callWeb).toHaveBeenCalledWith('POST', `/api/sessions/${sessionIdFor(row())}/account`, { to: 'work' }, expect.any(Number));
    expect(text()).toContain('moved to the work account (3 conversation entries moved)');
    expect(text()).toContain('restarted on it');
    expect(process.exitCode).toBeUndefined();
  });

  it('says what each outcome means: queued for its turn, recorded for a Claude that is not running', async () => {
    saveHistory([row()]);
    callWeb.mockResolvedValue({ ok: true, body: { ok: true, outcome: 'queued' } });
    await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
    expect(text()).toContain('when its turn ends');
    out = [];
    callWeb.mockResolvedValue({ ok: true, body: { ok: true, outcome: 'recorded', moved: 0 } });
    await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
    expect(text()).toContain('next start uses it');
  });

  it("prints work web's refusal and exits 1", async () => {
    saveHistory([row()]);
    callWeb.mockResolvedValue({ ok: false, status: 409, error: 'it already runs on “work”' });
    await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('already runs on');
  });

  it('a work web that did not answer in time is not "none": nothing is done here', async () => {
    saveHistory([row()]);
    callWeb.mockResolvedValue({ ok: false, status: -1, error: 'work web did not answer in time' });
    await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
    expect(process.exitCode).toBe(1);
    expect(loadHistory()[0].account).toBeUndefined();
  });

  it('needs --to, and a session', async () => {
    saveHistory([row()]);
    await run({ action: 'switch', name: 'api', folder: 'feat/x' });
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('Usage: work account switch');
    expect(callWeb).not.toHaveBeenCalled();
    process.exitCode = undefined;
    out = [];
    await run({ action: 'switch', name: 'nope', folder: 'feat/x', to: 'work' });
    expect(process.exitCode).toBe(1);
    expect(callWeb).not.toHaveBeenCalled();
  });

  describe('with no work web', () => {
    beforeEach(async () => {
      await run({ action: 'add', name: 'work', login: false });
      fs.writeFileSync(path.join(home, '.claude-work', '.credentials.json'), '{}');
      out = [];
      callWeb.mockResolvedValue({ ok: false, status: 0, error: 'work web is not running' });
    });

    it('a session whose Claude is not running: the conversations move and the account is recorded, and it says the next start uses it', async () => {
      saveHistory([row()]);
      fs.mkdirSync(projects('.claude'), { recursive: true });
      fs.writeFileSync(path.join(projects('.claude'), 'a.jsonl'), 'A');
      await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
      expect(process.exitCode).toBeUndefined();
      expect(fs.readFileSync(path.join(projects('.claude-work'), 'a.jsonl'), 'utf-8')).toBe('A');
      expect(fs.existsSync(projects('.claude'))).toBe(false);
      expect(loadHistory()[0].account).toBe('work');
      expect(text()).toContain('next start uses it');
      expect(text()).toContain('work web is not running');
    });

    it('its Claude running in the PTY host: nothing is moved (only work web can restart it)', async () => {
      saveHistory([row()]);
      hostPtys.list = [{ id: sessionIdFor(row()), exited: false }];
      await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
      expect(process.exitCode).toBe(1);
      expect(text()).toContain('start work web');
      expect(loadHistory()[0].account).toBeUndefined();
    });

    it('an account nobody is logged in to is refused', async () => {
      saveHistory([row()]);
      fs.rmSync(path.join(home, '.claude-work', '.credentials.json'));
      await run({ action: 'switch', name: 'api', folder: 'feat/x', to: 'work' });
      expect(process.exitCode).toBe(1);
      expect(text()).toContain('logged in');
      expect(loadHistory()[0].account).toBeUndefined();
    });
  });
});
