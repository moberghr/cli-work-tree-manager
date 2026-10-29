import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeAccounts,
  accountDir,
  configDirEnv,
  defaultAccountName,
  isLoggedIn,
  sessionAccount,
} from '../../../../src/core/agents/claude/accounts.js';
import { addAccount, loginOn, removeAccount, setDefaultAccount } from '../../../../src/core/agents/claude/account-admin.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';
import { AccountAdminError } from '../../../../src/core/agents/types.js';
import { getConfigPath, loadConfig } from '../../../../src/core/platform/config.js';
import { withReporter } from '../../../../src/core/platform/report.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const config = { claudeAccounts: { work: '/w', alpha: '/a' }, claudeAccount: 'work' };

describe('accounts', () => {
  it('lists the default first, then the configured ones by name, marking the default', () => {
    expect(claudeAccounts(config)).toEqual([
      { name: 'default', dir: path.join(home, '.claude'), isDefault: false },
      { name: 'alpha', dir: '/a', isDefault: false },
      { name: 'work', dir: '/w', isDefault: true },
    ]);
    expect(claudeAccounts(null)).toEqual([{ name: 'default', dir: path.join(home, '.claude'), isDefault: true }]);
  });

  it('finds a folder by name, null for an unknown one', () => {
    expect(accountDir('work', config)).toBe('/w');
    expect(accountDir('default', config)).toBe(path.join(home, '.claude'));
    expect(accountDir('nope', config)).toBeNull();
  });

  it('the default is the configured one when it exists, else `default`', () => {
    expect(defaultAccountName(config)).toBe('work');
    expect(defaultAccountName({ claudeAccount: 'gone' })).toBe('default');
    expect(defaultAccountName(null)).toBe('default');
  });

  it("a session's account is the recorded one; an old row is `default`, never the configured default", () => {
    expect(sessionAccount({ account: 'alpha' })).toBe('alpha');
    expect(sessionAccount({})).toBe('default');
    expect(sessionAccount(undefined)).toBe('default');
  });

  it('is logged in when the credentials file is there; missing is no, or unknown on macOS', () => {
    const dir = path.join(home, 'acc');
    fs.mkdirSync(dir);
    const missing = process.platform === 'darwin' ? null : false;
    expect(isLoggedIn(dir)).toBe(missing);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
    expect(isLoggedIn(dir)).toBe(true);
  });

  it('isLoggedIn by platform: macOS keeps credentials in the keychain (unknown), Linux and Windows in the file (T7)', () => {
    const dir = path.join(home, 'acc2');
    fs.mkdirSync(dir);
    expect(isLoggedIn(dir, 'darwin')).toBeNull();
    expect(isLoggedIn(dir, 'linux')).toBe(false);
    expect(isLoggedIn(dir, 'win32')).toBe(false);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
    expect(isLoggedIn(dir, 'darwin')).toBe(true);
    expect(isLoggedIn(dir, 'linux')).toBe(true);
  });

  it('sets CLAUDE_CONFIG_DIR for a configured account only', () => {
    expect(configDirEnv('work', config)).toEqual({ CLAUDE_CONFIG_DIR: '/w' });
    expect(configDirEnv('default', config)).toEqual({});
    expect(configDirEnv('nope', config)).toEqual({});
  });
});

describe('account admin', () => {
  const writeConfig = (extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [], unknownKey: 1, ...extra }),
    );
  };
  const raw = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;

  it('adds an account with the default folder, makes it, and keeps unknown keys', async () => {
    writeConfig();
    const dir = await addAccount('work');
    expect(dir).toBe(path.join(home, '.claude-work'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(raw().claudeAccounts).toEqual({ work: dir });
    expect(raw().unknownKey).toBe(1);
    expect(loadConfig()?.claudeAccounts).toEqual({ work: dir });
  });

  it('takes a given folder, expanding ~', async () => {
    writeConfig();
    expect(await addAccount('two', '~/somewhere/two')).toBe(path.join(home, 'somewhere', 'two'));
  });

  it('refuses a taken name, a taken folder, bad names, ~/.claude and relative folders', async () => {
    writeConfig();
    const dir = await addAccount('work');
    await expect(addAccount('work', path.join(home, 'x'))).rejects.toThrow(/already an account/);
    await expect(addAccount('other', dir)).rejects.toThrow(/already another account/);
    await expect(addAccount('default')).rejects.toBeInstanceOf(AccountAdminError);
    await expect(addAccount('Bad Name')).rejects.toThrow(/not a valid account name/);
    await expect(addAccount('home', '~/.claude')).rejects.toThrow(/default account/);
    await expect(addAccount('rel', 'relative/dir')).rejects.toThrow(/absolute/);
    expect(Object.keys(raw().claudeAccounts as object)).toEqual(['work']);
  });

  it('refuses a folder in the worktrees root, a repo or ~/.work, writing nothing', async () => {
    const wt = path.join(home, 'wt');
    const repo = path.join(home, 'src', 'api');
    writeConfig({ worktreesRoot: wt, repos: { api: repo } });
    await expect(addAccount('a', path.join(wt, 'x'))).rejects.toThrow(/inside/);
    await expect(addAccount('b', wt)).rejects.toThrow(/inside/);
    await expect(addAccount('c', path.join(repo, '.claude'))).rejects.toThrow(/inside/);
    await expect(addAccount('d', path.join(home, '.work', 'acc'))).rejects.toThrow(/inside/);
    expect(raw().claudeAccounts).toBeUndefined();
    expect(fs.existsSync(path.join(wt, 'x'))).toBe(false);
    expect(await addAccount('e', path.join(home, 'src', 'api2'))).toBe(path.join(home, 'src', 'api2'));
  });

  it('needs a config', async () => {
    await expect(addAccount('work')).rejects.toThrow(/work init/);
  });

  it('sets the default to `default` or an account, refusing an unknown one', async () => {
    writeConfig();
    await addAccount('work');
    await setDefaultAccount('work');
    expect(raw().claudeAccount).toBe('work');
    await setDefaultAccount('default');
    expect(raw().claudeAccount).toBe('default');
    await expect(setDefaultAccount('nope')).rejects.toThrow(/no account/);
  });

  it('removes an account, keeps its folder, and the default goes back to `default`', async () => {
    writeConfig();
    const dir = await addAccount('work');
    await setDefaultAccount('work');
    await removeAccount('work', () => ({ live: [], archived: [] }));
    expect(raw().claudeAccounts).toBeUndefined();
    expect(raw().claudeAccount).toBe('default');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses a removal naming the live sessions, then the archived ones, an unknown account and `default`', async () => {
    writeConfig();
    await addAccount('work');
    const none = () => ({ live: [], archived: [] });
    const err = await removeAccount('work', () => ({ live: ['api · feat/x'], archived: ['old · feat/y'] })).catch(
      (e: AccountAdminError) => e,
    );
    expect(err).toBeInstanceOf(AccountAdminError);
    expect((err as AccountAdminError).sessions).toEqual(['api · feat/x']);
    expect((err as AccountAdminError).kind).toBe('live');
    const arch = await removeAccount('work', () => ({ live: [], archived: ['old · feat/y'] })).catch((e: AccountAdminError) => e);
    expect((arch as AccountAdminError).kind).toBe('archived');
    expect((arch as AccountAdminError).message).toMatch(/1 archived session on work.*default account/);
    expect(Object.keys(raw().claudeAccounts as object)).toEqual(['work']);
    await expect(removeAccount('nope', none)).rejects.toThrow(/no account/);
    await expect(removeAccount('default', none)).rejects.toThrow(/default account/);
  });

  it('asks who uses it under the config lock, right before the write (once, and not for a refused name)', async () => {
    writeConfig();
    await addAccount('work');
    const usedBy = vi.fn(() => ({ live: [], archived: [] }));
    await removeAccount('nope', usedBy).catch(() => {});
    expect(usedBy).not.toHaveBeenCalled();
    await removeAccount('work', usedBy);
    expect(usedBy).toHaveBeenCalledTimes(1);
  });
});

describe("the adapter's accounts part: agent-neutral names for core (A2)", () => {
  const writeConfig = (extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [], ...extra }));
  };
  const accounts = claudeAgent.accounts!;

  it('defaultName and has follow the config', () => {
    writeConfig({ claudeAccounts: { work: path.join(home, 'w') }, claudeAccount: 'work' });
    expect(accounts.defaultName()).toBe('work');
    expect(accounts.has('work')).toBe(true);
    expect(accounts.has('default')).toBe(true);
    expect(accounts.has('nope')).toBe(false);
  });

  it("login starts the configured Claude command on the account's folder, in this terminal", () => {
    const dir = path.join(home, 'w');
    writeConfig({ claudeAccounts: { work: dir }, aiCommand: 'claude --model opus' });
    const run = vi.fn();
    loginOn('work', run as never);
    const [cmd, args, opts] = run.mock.calls[0] as [string, string[], { stdio: string; windowsHide: boolean; env: Record<string, string> }];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--model', 'opus']);
    expect(opts).toMatchObject({ stdio: 'inherit', windowsHide: false });
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(dir);
    // Another agent as aiCommand: Claude's own login is still `claude`.
    writeConfig({ claudeAccounts: { work: dir }, aiCommand: 'opencode', unused: 1 });
    loginOn('work', run as never);
    expect(run.mock.calls[1]![0]).toBe('claude');
    expect(() => loginOn('nope', run as never)).toThrow(AccountAdminError);
  });

  it('installSkills refuses an unknown account', () => {
    writeConfig();
    expect(accounts.admin!.installSkills('nope')).toEqual({ ok: false, message: 'no account “nope”' });
  });
});

describe('the account rules, applied where config is read (A3)', () => {
  const write = (cfg: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', ...cfg }));
  };
  /** The accounts as the current config gives them, and what was warned meanwhile. */
  const read = () => {
    const warnings: string[] = [];
    const list = withReporter(
      (level, text) => {
        if (level === 'warn') warnings.push(text);
      },
      () => claudeAccounts(),
    );
    return { configured: Object.fromEntries(list.filter((a) => a.name !== 'default').map((a) => [a.name, a.dir])), list, warnings };
  };
  const dir = (n: string) => path.join(home, n);

  it('keeps valid accounts, expands ~, and the default when it names one', () => {
    write({ claudeAccounts: { work: dir('.claude-work'), 'p-2': '~/.claude-p2' }, claudeAccount: 'work' });
    const { configured, list, warnings } = read();
    expect(configured).toEqual({ work: dir('.claude-work'), 'p-2': path.join(home, '.claude-p2') });
    expect(list.find((a) => a.isDefault)?.name).toBe('work');
    expect(warnings).toEqual([]);
  });

  it('drops bad names, relative folders, ~/.claude and shared folders, each with a warning', () => {
    write({
      claudeAccounts: {
        default: dir('a'),
        'Bad Name': dir('b'),
        '-lead': dir('c'),
        rel: 'relative/folder',
        home: path.join(home, '.claude'),
        num: 5,
        ok: dir('ok'),
        twin: dir('ok'),
      },
    });
    const { configured, warnings } = read();
    expect(configured).toEqual({ ok: dir('ok') });
    expect(warnings).toHaveLength(7);
  });

  it('compares folders case-blind on Windows only', () => {
    write({ claudeAccounts: { a: dir('Same'), b: dir('same') } });
    expect(Object.keys(read().configured)).toEqual(process.platform === 'win32' ? ['a'] : ['a', 'b']);
  });

  it('drops a folder that is, or is inside, the worktrees root, a repo or ~/.work', () => {
    const wt = dir('wt');
    const repo = dir('repos/api');
    write({
      worktreesRoot: wt,
      repos: { api: repo },
      claudeAccounts: {
        root: wt,
        inwt: path.join(wt, 'feat-x', '.claude'),
        inrepo: path.join(repo, '.claude-r'),
        work: path.join(home, '.work', 'claude'),
        beside: dir('repos/api-other'),
      },
    });
    const { configured, warnings } = read();
    expect(configured).toEqual({ beside: dir('repos/api-other') });
    expect(warnings).toHaveLength(4);
    expect(warnings.every((w) => /inside/.test(w))).toBe(true);
  });

  it('says each problem once per change of the config, however often the accounts are read', () => {
    write({ claudeAccounts: { once: 'relative/once' }, claudeAccount: 'missing-once' });
    expect(read().warnings).toHaveLength(2);
    expect(read().warnings).toEqual([]);
    expect(defaultAccountName()).toBe('default');
    write({ claudeAccounts: { once: 'relative/twice', x: dir('x') } });
    expect(read().warnings).toHaveLength(1);
  });

  it('drops a default that is not `default` or an account, with a warning', () => {
    write({ claudeAccounts: { work: dir('w') }, claudeAccount: 'gone' });
    const { list, warnings } = read();
    expect(list.find((a) => a.isDefault)?.name).toBe('default');
    expect(warnings).toHaveLength(1);
  });

  it('a config handed in is checked by the same rules, without a warning', () => {
    const warnings: string[] = [];
    const list = withReporter(
      (level, text) => {
        if (level === 'warn') warnings.push(text);
      },
      () => claudeAccounts({ claudeAccounts: { ok: dir('ok'), 'Bad Name': dir('b') }, claudeAccount: 'Bad Name' }),
    );
    expect(list.map((a) => a.name)).toEqual(['default', 'ok']);
    expect(list[0]!.isDefault).toBe(true);
    expect(warnings).toEqual([]);
  });
});
