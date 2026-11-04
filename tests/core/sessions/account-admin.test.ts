import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgent, agentById, AccountAdminError, type AgentAccounts, type AgentAdapter } from '../../../src/core/agents/index.js';
import {
  accountOverview,
  accountSkillsNote,
  addAgentAccount,
  createAccountLogins,
  setDefaultAgentAccount,
  type AccountLoginDeps,
} from '../../../src/core/sessions/account-admin.js';
import { accountSkillsInChild } from '../../../src/core/sessions/account-skills-child.js';
import { accountNameProblem } from '../../../src/core/sessions/account-names.js';
import { createActivityLog } from '../../../src/core/platform/activity.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** What `work account` and the Accounts page share (account-admin.ts): the overview, add / default, the login terminals. */

const row = (target: string, o: { account?: string; archivedAt?: string } = {}) =>
  ({ target, branch: 'feat/x', isGroup: false, paths: ['/p'], createdAt: '', lastAccessedAt: '', agent: 'echo', ...o }) as WorktreeSession;

function echoAccounts(over: Partial<NonNullable<AgentAccounts['admin']>> = {}, withAdmin = true): AgentAccounts {
  return {
    list: () => [
      { name: 'home', dir: '/h', isDefault: true, loggedIn: true },
      { name: 'spare', dir: '/s', isDefault: false, loggedIn: false },
    ],
    defaultName: () => 'home',
    has: (n) => n === 'home' || n === 'spare',
    current: (s) => s.account || 'home',
    switchFiles: async () => ({ moved: [] }),
    folders: () => [],
    ...(withAdmin
      ? {
          admin: {
            add: vi.fn(async (name: string, dir?: string) => dir ?? `/home/.echo-${name}`),
            setDefault: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
            login: () => {},
            loginLaunch: () => ({ tool: { cmd: 'echo', baseArgs: [], resumeFlag: '', promptFileFlag: '', promptFlag: '' }, agentEnv: {} }),
            installSkills: () => ({ ok: true, message: '' }),
            ...over,
          },
        }
      : {}),
  };
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('accountOverview', () => {
  it('each account with who is on it (live and archived apart) and its last reading', () => {
    const accounts = echoAccounts();
    unregister = registerAgent({ ...agentById('echo'), id: 'echo', name: 'Echo', accounts } as AgentAdapter);
    const reading = { account: 'spare', at: '2026-11-01T10:00:00Z', windows: [] };
    const o = accountOverview(
      accounts,
      [reading],
      [row('a', { account: 'spare' }), row('b', { account: 'spare', archivedAt: 'x' }), row('c')],
    );
    expect(o).toEqual([
      { name: 'home', dir: '/h', isDefault: true, loggedIn: true, live: ['c · feat/x'], archived: [], usage: null },
      { name: 'spare', dir: '/s', isDefault: false, loggedIn: false, live: ['a · feat/x'], archived: ['b · feat/x'], usage: reading },
    ]);
  });
});

describe('add / default', () => {
  it("go through the agent's admin (a blank folder means its default place); an agent work doesn't manage is refused", async () => {
    const accounts = echoAccounts();
    expect(await addAgentAccount(accounts, 'work', '  ')).toBe('/home/.echo-work');
    expect(await addAgentAccount(accounts, 'work', '/x')).toBe('/x');
    await setDefaultAgentAccount(accounts, 'spare');
    expect(accounts.admin!.setDefault).toHaveBeenCalledWith('spare');
    await expect(addAgentAccount(echoAccounts({}, false), 'w')).rejects.toThrow(AccountAdminError);
    await expect(setDefaultAgentAccount(undefined, 'w')).rejects.toThrow('not managed by work');
  });
});

describe('accountNameProblem (the Add form and the server, one rule)', () => {
  it('refuses the default, a bad name and a taken one', () => {
    expect(accountNameProblem('default')).toContain("can't be reused");
    expect(accountNameProblem('Work')).toContain('not a valid account name');
    expect(accountNameProblem('-x')).toContain('not a valid account name');
    expect(accountNameProblem('work', ['default', 'work'])).toBe('there is already an account “work”');
    expect(accountNameProblem('work-2', ['default'])).toBeNull();
  });
});

describe('createAccountLogins', () => {
  function setup(over: Partial<AccountLoginDeps> = {}) {
    const known = new Set(['work']);
    const deps: AccountLoginDeps = {
      has: (n) => known.has(n),
      start: vi.fn(async (n: string) => `account-login:${n}`),
      stop: vi.fn(async () => {}),
      installSkills: vi.fn(async () => ({ ok: true, message: 'installed the plugin' })),
      note: vi.fn(),
      ...over,
    };
    return { deps, known, logins: createAccountLogins(deps) };
  }

  it('starts a known account’s terminal and refuses an unknown one, starting nothing', async () => {
    const { deps, logins } = setup();
    expect(await logins.start('work')).toBe('account-login:work');
    await expect(logins.start('nope')).rejects.toThrow(AccountAdminError);
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it("puts work's skills into the account after its first login only — stopped first, then installed, once", async () => {
    const { deps, logins } = setup();
    const first = await logins.stop('work');
    expect(deps.stop).toHaveBeenCalledWith('work');
    expect(await first.skills).toEqual({ ok: true, message: 'installed the plugin' });
    expect(deps.note).toHaveBeenCalledWith('work', { ok: true, message: 'installed the plugin' });
    expect((await logins.stop('work')).skills).toBeNull();
    expect(deps.installSkills).toHaveBeenCalledTimes(1);
  });

  it('a failed install (or one that throws) is said and tried again at the next close', async () => {
    const installSkills = vi
      .fn<AccountLoginDeps['installSkills']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, message: 'ok' });
    const { deps, logins } = setup({ installSkills });
    expect(await (await logins.stop('work')).skills).toEqual({ ok: false, message: 'offline' });
    expect(await (await logins.stop('work')).skills).toEqual({ ok: true, message: 'ok' });
    expect(deps.note).toHaveBeenCalledTimes(2);
  });

  it('two closes at once install once; an account that is gone gets none', async () => {
    let finish!: (r: { ok: boolean; message: string }) => void;
    const { deps, logins } = setup({ installSkills: vi.fn(() => new Promise<{ ok: boolean; message: string }>((r) => (finish = r))) });
    const a = await logins.stop('work');
    expect((await logins.stop('work')).skills).toBeNull(); // still installing
    finish({ ok: true, message: 'ok' });
    await a.skills;
    expect(deps.installSkills).toHaveBeenCalledTimes(1);
    const gone = setup({ has: () => false });
    expect((await gone.logins.stop('work')).skills).toBeNull();
    expect(gone.deps.stop).toHaveBeenCalledWith('work'); // its terminal is still stopped
    expect(gone.deps.installSkills).not.toHaveBeenCalled();
  });
});

describe('accountSkillsNote', () => {
  it('an Activity run per install: done, or failed with how to do it by hand', () => {
    const activity = createActivityLog();
    const note = accountSkillsNote(activity);
    note('work', { ok: true, message: 'installed' });
    note('spare', { ok: false, message: 'offline' });
    const runs = activity.snapshot().recent;
    const failed = runs.find((r) => r.label.includes('spare'))!;
    expect(failed).toMatchObject({ kind: 'accounts', status: 'failed', summary: 'offline' });
    expect(failed.notes[0]?.text).toContain('work account skills spare');
    expect(runs.find((r) => r.label.includes('work'))).toMatchObject({ status: 'done', summary: 'installed' });
  });
});

describe('accountSkillsInChild', () => {
  it('runs `work account skills <name>` in a child and reads how it went', async () => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: 'installed the Claude Code plugin\n', stderr: '', code: 0, timedOut: false });
    const install = accountSkillsInChild(() => '/bin/work.js', run);
    expect(await install('work')).toEqual({ ok: true, message: 'installed the Claude Code plugin' });
    expect(run).toHaveBeenCalledWith(
      '/bin/work.js',
      ['account', 'skills', 'work'],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    run.mockResolvedValueOnce({ stdout: '', stderr: 'could not install\n', code: 1, timedOut: false });
    expect(await install('work')).toEqual({ ok: false, message: 'could not install' });
    run.mockResolvedValueOnce({ stdout: '', stderr: '', code: null, timedOut: true });
    expect((await install('work')).ok).toBe(false);
    run.mockResolvedValueOnce({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: 'ENOENT' });
    expect(await install('work')).toEqual({ ok: false, message: "couldn't start work: ENOENT" });
  });
});
