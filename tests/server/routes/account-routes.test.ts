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
