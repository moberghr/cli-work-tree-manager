import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountAccountRoutes } from '../../../src/server/routes/account-routes.js';
import { createAccountSwitcher, type AccountSwitchDeps } from '../../../src/core/sessions/account-switch.js';
import { saveConfig } from '../../../src/core/platform/config.js';
import type { AccountsWire, AccountSwitchWire } from '../../../src/core/api-types.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** GET /api/accounts and POST /api/sessions/:id/account, over a switcher with fake I/O. */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const now = new Date().toISOString();
let s: WorktreeSession;
function setup(over: Partial<AccountSwitchDeps> = {}, lookOnly?: string) {
  s = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/x'], createdAt: now, lastAccessedAt: now };
  const events: string[] = [];
  const log: string[] = [];
  const deps: AccountSwitchDeps = {
    session: (id) => (id === 'api' ? s : null),
    beingArchived: () => false,
    accounts: (x) => ({
      list: [
        { name: 'default', dir: '/a', isDefault: true, loggedIn: true },
        { name: 'work', dir: '/b', isDefault: false, loggedIn: true },
      ],
      current: x.account ?? 'default',
    }),
    switchFiles: async () => (log.push('move'), { moved: ['x', 'y', 'z'] }),
    record: async (x, to) => void (log.push(`record ${to}`), (s = { ...x, account: to })),
    hostRuns: () => false,
    runningOutside: () => false,
    busy: () => false,
    halt: async () => (log.push('halt'), 'halted' as const),
    resume: async () => void log.push('resume'),
    ...over,
  };
  const app = new Hono();
  mountAccountRoutes(app, { switcher: createAccountSwitcher(deps), broadcast: (e) => events.push(e), lookOnly });
  const post = (id: string, body: unknown) =>
    app.request(`/api/sessions/${id}/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post, events, log };
}

describe('DELETE /api/sessions/:id/account (review W6)', () => {
  it('drops the switch waiting for its turn; 409 when none waits; the dev server cancels nothing', async () => {
    const { app, post, events } = setup({ hostRuns: () => true, busy: () => true });
    expect(await (await post('api', { to: 'work' })).json()).toMatchObject({ outcome: 'queued' });
    const del = () => app.request('/api/sessions/api/account', { method: 'DELETE' });
    const r = await del();
    expect(r.status).toBe(200);
    expect(events.at(-1)).toBe('sessions-changed');
    const again = await del();
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('no switch is waiting');
    const dev = setup({}, 'the dev server switches nothing');
    expect((await dev.app.request('/api/sessions/api/account', { method: 'DELETE' })).status).toBe(409);
  });
});

describe('GET /api/accounts', () => {
  it('the default and the configured accounts, with whether each is logged in, and which one new sessions use', async () => {
    const work = path.join(home, '.claude-work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, '.credentials.json'), '{}');
    saveConfig({
      worktreesRoot: path.join(home, 'wt'),
      repos: {},
      groups: {},
      copyFiles: [],
      claudeAccounts: { work },
      claudeAccount: 'work',
    });
    const { app } = setup();
    const w = (await (await app.request('/api/accounts')).json()) as AccountsWire;
    expect(w.default).toBe('work');
    expect(w.accounts.map((a) => [a.name, a.isDefault, a.dir])).toEqual([
      ['default', false, path.join(home, '.claude')],
      ['work', true, work],
    ]);
    expect(w.accounts[1].loggedIn).toBe(true);
    expect(w.accounts[0].loggedIn).toBe(process.platform === 'darwin' ? null : false);
  });

  it('with no accounts configured, just the default', async () => {
    saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [] });
    const w = (await (await setup().app.request('/api/accounts')).json()) as AccountsWire;
    expect(w.accounts.map((a) => a.name)).toEqual(['default']);
    expect(w.default).toBe('default');
  });
});

describe('POST /api/sessions/:id/account', () => {
  it('moves a session that is not running, says so, and tells the dashboard', async () => {
    const { post, events, log } = setup();
    const res = await post('api', { to: 'work' });
    expect(res.status).toBe(200);
    expect((await res.json()) satisfies AccountSwitchWire).toEqual({ ok: true, outcome: 'recorded', moved: 3 });
    expect(log).toEqual(['move', 'record work']);
    expect(events).toEqual(['sessions-changed']);
  });

  it('a running idle one is restarted (switched); a busy one is queued', async () => {
    const a = setup({ hostRuns: () => true });
    expect(await (await a.post('api', { to: 'work' })).json()).toMatchObject({ outcome: 'switched' });
    expect(a.log).toEqual(['halt', 'move', 'record work', 'resume']);
    const b = setup({ hostRuns: () => true, busy: () => true });
    const res = await b.post('api', { to: 'work' });
    expect(await res.json()).toEqual({ ok: true, outcome: 'queued' });
    expect(b.log).toEqual([]);
  });

  it('refusals come back as their status with the reason, and tell nobody', async () => {
    const { post, events } = setup();
    expect((await post('nope', { to: 'work' })).status).toBe(404);
    const unknown = await post('api', { to: 'nope' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('no account');
    const same = await post('api', { to: 'default' });
    expect(same.status).toBe(409);
    expect(events).toEqual([]);
  });

  it('a failing move is a 502 that keeps the old account', async () => {
    const { post, log } = setup({ switchFiles: async () => Promise.reject(new Error('EBUSY')) });
    const res = await post('api', { to: 'work' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('stays on default');
    expect(log).toEqual([]);
    expect(s.account).toBeUndefined();
  });

  it('wants {to}', async () => {
    const { post } = setup();
    expect((await post('api', {})).status).toBe(400);
    expect((await post('api', { to: '' })).status).toBe(400);
  });

  it('the dev server lists but switches nothing, and says why', async () => {
    const { post, log } = setup({}, 'the dev server switches nothing');
    const res = await post('api', { to: 'work' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('dev server');
    expect(log).toEqual([]);
  });
});

describe('the Accounts page: add, default, remove, login', () => {
  const config = (accounts: Record<string, string> = {}) =>
    saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [], claudeAccounts: accounts });
  const fakeLogins = () => {
    const calls: string[] = [];
    return {
      calls,
      logins: {
        start: vi.fn(async (n: string) => (calls.push(`start ${n}`), `account-login:${n}`)),
        stop: vi.fn(async (n: string) => {
          calls.push(`stop ${n}`);
          return { skills: Promise.resolve({ ok: true, message: 'ok' }) };
        }),
      },
    };
  };
  function mount(o: { sessions?: WorktreeSession[]; lookOnly?: string; logins?: boolean } = {}) {
    const events: string[] = [];
    const f = fakeLogins();
    const app = new Hono();
    mountAccountRoutes(app, {
      switcher: createAccountSwitcher({} as AccountSwitchDeps),
      broadcast: (e) => events.push(e),
      lookOnly: o.lookOnly,
      ...(o.logins === false ? {} : { logins: f.logins }),
      sessions: () => o.sessions ?? [],
      readings: () => [
        { account: 'default', at: now, windows: [{ id: 'five_hour', label: '5-hour limit', usedPercent: 40, resetsAt: null }] },
      ],
    });
    const call = (method: string, url: string, body?: unknown) =>
      app.request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { app, events, call, ...f };
  }
  const sessionOn = (account: string, archivedAt?: string): WorktreeSession => ({
    target: 'api',
    branch: `feat/${account}`,
    isGroup: false,
    paths: ['/wt/x'],
    createdAt: now,
    lastAccessedAt: now,
    account,
    ...(archivedAt ? { archivedAt } : {}),
  });

  it('GET says who runs on each account, its last reading, and that the page may manage them', async () => {
    config({ work: path.join(home, '.claude-work') });
    const { app } = mount({ sessions: [sessionOn('work'), sessionOn('work', now)] });
    const w = (await (await app.request('/api/accounts')).json()) as AccountsWire;
    expect(w.canManage).toBe(true);
    const work = w.accounts.find((a) => a.name === 'work')!;
    expect(work.liveSessions).toEqual(['api · feat/work']);
    expect(work.archivedSessions).toEqual(['api · feat/work']);
    expect(w.accounts[0].usage?.windows[0]?.usedPercent).toBe(40);
    expect(work.usage).toBeNull();
  });

  it('POST /api/accounts records it in config.json and makes its folder (default ~/.claude-<name>); a bad name is a 400', async () => {
    config();
    const { call, events } = mount();
    const r = await call('POST', '/api/accounts', { name: 'work' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: 'work', dir: path.join(home, '.claude-work') });
    expect(fs.existsSync(path.join(home, '.claude-work'))).toBe(true);
    expect(events).toEqual(['accounts-changed']);
    const bad = await call('POST', '/api/accounts', { name: 'Not Valid' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('not a valid account name');
    const taken = await call('POST', '/api/accounts', { name: 'work' });
    expect(((await taken.json()) as { error: string }).error).toContain('already an account');
    // A folder inside work's own state is refused by the same rules as `work account add`.
    const inside = await call('POST', '/api/accounts', { name: 'w2', folder: path.join(home, '.work', 'x') });
    expect(inside.status).toBe(400);
  });

  it('POST …/default chooses it; an unknown one is a 400', async () => {
    config({ work: path.join(home, '.claude-work') });
    const { call, app } = mount();
    expect((await call('POST', '/api/accounts/work/default')).status).toBe(200);
    expect(((await (await app.request('/api/accounts')).json()) as AccountsWire).default).toBe('work');
    expect((await call('POST', '/api/accounts/nope/default')).status).toBe(400);
  });

  it('DELETE: refused while a live session runs on it (never forced); archived ones refuse it until force; stops its login terminal', async () => {
    const work = path.join(home, '.claude-work');
    fs.mkdirSync(work);
    config({ work });
    const live = mount({ sessions: [sessionOn('work')] });
    const r = await live.call('DELETE', '/api/accounts/work?force=1');
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ kind: 'live', sessions: ['api · feat/work'] });

    const archived = mount({ sessions: [sessionOn('work', now)] });
    const a = await archived.call('DELETE', '/api/accounts/work');
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ kind: 'archived', sessions: ['api · feat/work'] });
    const forced = await archived.call('DELETE', '/api/accounts/work?force=1');
    expect(forced.status).toBe(200);
    expect(archived.calls).toEqual(['stop work']);
    expect(archived.events).toEqual(['accounts-changed']);
    expect(fs.existsSync(work)).toBe(true); // its folder stays
    expect((await archived.call('DELETE', '/api/accounts/default')).status).toBe(400);
  });

  it('login: starts its terminal (its id for the WebSocket), stops it, and the page hears of both', async () => {
    config({ work: path.join(home, '.claude-work') });
    const { call, calls, events } = mount();
    const r = await call('POST', '/api/accounts/work/login');
    expect(await r.json()).toEqual({ ok: true, id: 'account-login:work' });
    const s = await call('DELETE', '/api/accounts/work/login');
    expect(await s.json()).toEqual({ ok: true, installingSkills: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toEqual(['start work', 'stop work']);
    expect(events).toEqual(['accounts-changed', 'accounts-changed']);
  });

  it('the dev server (look only) lists them but changes nothing; without login terminals the page says why', async () => {
    config({ work: path.join(home, '.claude-work') });
    const dev = mount({ lookOnly: 'the dev server changes no account' });
    const w = (await (await dev.app.request('/api/accounts')).json()) as AccountsWire;
    expect(w).toMatchObject({ canManage: false, manageNote: 'the dev server changes no account' });
    const asks: Array<[string, string]> = [
      ['POST', '/api/accounts'],
      ['POST', '/api/accounts/work/default'],
      ['DELETE', '/api/accounts/work'],
      ['POST', '/api/accounts/work/login'],
      ['DELETE', '/api/accounts/work/login'],
    ];
    for (const [m, u] of asks) {
      const r = await dev.call(m, u, u === '/api/accounts' ? { name: 'x' } : undefined);
      expect(r.status, `${m} ${u}`).toBe(409);
    }
    expect(dev.calls).toEqual([]);
    expect(dev.events).toEqual([]);
    const none = mount({ logins: false });
    expect(((await (await none.app.request('/api/accounts')).json()) as AccountsWire).canManage).toBe(false);
    expect((await none.call('POST', '/api/accounts/work/login')).status).toBe(409);
  });
});
