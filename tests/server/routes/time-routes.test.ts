import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountTimeRoutes } from '../../../src/server/routes/time-routes.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import type { TimeDeps } from '../../../src/core/time/time-days.js';
import type { TimeDaysWire, TimeDayWire, TimeGraphWire, TimePostWire } from '../../../src/core/api-types.js';
import type { GraphAccess } from '../../../src/server/routes/time-routes.js';
import type { TempoApi, TempoWorklog } from '../../../src/core/time/tempo.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

// Each test file has its own HOME (tests/setup): state.db is a throwaway.
const deps: TimeDeps = {
  sessions: () => [
    { target: 'api', branch: 'feat/SD-1-x', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '' } as WorktreeSession,
  ],
  minutesOn: async () => 30,
  commits: async () => [],
  jiraMoved: async () => [],
  titles: async () => ({ 'SD-1': 'One' }),
  settings: () => ({ ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434' }),
  issueId: async (k) => ({ 'SD-1': 1, 'SD-434': 434, 'SD-9': 9 })[k] ?? null,
};

function app() {
  const a = new Hono();
  const broadcast = vi.fn();
  mountTimeRoutes(a, { deps, broadcast });
  return { a, broadcast };
}
const send = (a: Hono, method: string, url: string, body?: unknown) =>
  a.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('connecting Outlook and Teams', () => {
  const graphApp = (over: Partial<GraphAccess> = {}) => {
    let account: string | null = null;
    let finish: (v: string) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const access: GraphAccess = {
      app: () => ({ clientId: 'c', tenantId: 't' }),
      start: async () => ({
        userCode: 'ABCD-1234',
        verificationUri: 'https://microsoft.com/devicelogin',
        deviceCode: 'd',
        expiresAt: Date.parse('2026-10-08T12:15:00Z'),
        intervalMs: 5000,
      }),
      finish: () =>
        new Promise<string>((res, rej) => {
          finish = (v) => {
            account = v;
            res(v);
          };
          fail = rej;
        }),
      account: () => account,
      signOut: () => (account = null),
      ...over,
    };
    const a = new Hono();
    const broadcast = vi.fn();
    const onGraphChanged = vi.fn();
    mountTimeRoutes(a, { deps, broadcast, graph: access, onGraphChanged });
    return { a, broadcast, onGraphChanged, finish: (v: string) => finish(v), fail: (e: Error) => fail(e) };
  };
  const status = async (a: Hono) => (await (await a.request('/api/time/graph')).json()) as TimeGraphWire;

  it('connect shows the code; once entered: signed in, the tab told, today rebuilt; disconnect signs out', async () => {
    const g = graphApp();
    expect(await status(g.a)).toEqual({ ready: true, why: null, account: null, login: null, error: null });
    const started = (await (await send(g.a, 'POST', '/api/time/graph/connect')).json()) as TimeGraphWire;
    expect(started.login).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://microsoft.com/devicelogin',
      expiresAt: '2026-10-08T12:15:00.000Z',
    });
    g.finish('you@moberg.hr');
    await new Promise((r) => setTimeout(r, 0));
    expect(await status(g.a)).toMatchObject({ account: 'you@moberg.hr', login: null });
    expect(g.broadcast).toHaveBeenCalledWith('time-graph-changed', {});
    expect(g.onGraphChanged).toHaveBeenCalled();
    expect(((await (await send(g.a, 'POST', '/api/time/graph/disconnect')).json()) as TimeGraphWire).account).toBeNull();
  });

  it("a sign-in that fails says why; no app registration: refused with it; GET /api/time/graph isn't a day", async () => {
    const g = graphApp();
    await send(g.a, 'POST', '/api/time/graph/connect');
    g.fail(new Error('The sign-in code expired: connect again.'));
    await new Promise((r) => setTimeout(r, 0));
    expect(await status(g.a)).toMatchObject({ login: null, error: 'The sign-in code expired: connect again.' });
    const none = graphApp({ app: () => ({ why: 'No app to sign in with' }) });
    expect((await send(none.a, 'POST', '/api/time/graph/connect')).status).toBe(409);
    expect(await status(none.a)).toMatchObject({ ready: false, why: 'No app to sign in with' });
  });
});

describe('posting a day to Tempo', () => {
  const tempoApp = (api: TempoApi | null) => {
    const a = new Hono();
    mountTimeRoutes(a, {
      deps,
      broadcast: vi.fn(),
      tempo: () => (api ? { api, accountId: 'acc-1' } : { why: 'No Tempo token: set TEMPO_API_TOKEN' }),
    });
    return a;
  };
  const fake = () => {
    let next = 100;
    return {
      list: vi.fn(async (): Promise<TempoWorklog[]> => []),
      create: vi.fn(async () => next++),
      remove: vi.fn(async () => {}),
    } satisfies TempoApi;
  };

  it('not set up: the day says why, and a post is refused with it', async () => {
    const a = tempoApp(null);
    expect(((await (await a.request('/api/time/2026-10-06')).json()) as TimeDayWire).posting).toEqual({
      ready: false,
      why: 'No Tempo token: set TEMPO_API_TOKEN',
    });
    const res = await send(a, 'POST', '/api/time/2026-10-06/post');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Tempo token: set TEMPO_API_TOKEN' });
  });

  it('posts the day as shown; it reads "in Tempo"; an edit makes it "changed", and posting again removes and adds only what changed', async () => {
    const api = fake();
    const a = tempoApp(api);
    await send(a, 'POST', '/api/time/2026-10-06/rebuild');
    const r = (await (await send(a, 'POST', '/api/time/2026-10-06/post')).json()) as TimePostWire;
    expect(r).toMatchObject({ posted: 2, removed: 0, failed: [] });
    expect(r.day.status).toBe('posted');
    expect(api.create).toHaveBeenCalledTimes(2);
    // Tempo now has them (as work posted them).
    api.list.mockResolvedValue([
      { tempoWorklogId: 100, issueId: 1, timeSpentSeconds: 9000, startDate: '2026-10-06', startTime: '09:00:00' },
      { tempoWorklogId: 101, issueId: 434, timeSpentSeconds: 18000, startDate: '2026-10-06', startTime: '11:30:00' },
    ]);
    const edited = (await (
      await send(a, 'PUT', '/api/time/2026-10-06', {
        entries: [
          { key: 'SD-1', hours: 2.5 },
          { key: 'SD-9', hours: 5 },
        ],
      })
    ).json()) as TimeDayWire;
    expect(edited.status).toBe('changed');
    const again = (await (await send(a, 'POST', '/api/time/2026-10-06/post')).json()) as TimePostWire;
    expect(again).toMatchObject({ kept: 1, removed: 1, posted: 1 });
    expect(api.remove).toHaveBeenCalledWith(101);
    expect(again.day.status).toBe('posted');
  });

  it("Tempo's day can't be read: nothing changed, and it says why", async () => {
    const api = fake();
    api.list.mockRejectedValue(new Error('Tempo list: 401 Unauthorized'));
    const a = tempoApp(api);
    const res = await send(a, 'POST', '/api/time/2026-10-05/post');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Tempo list: 401 Unauthorized' });
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('time routes', () => {
  it('rebuild gathers a day; GET serves it; the list has it', async () => {
    const { a, broadcast } = app();
    const built = (await (await send(a, 'POST', '/api/time/2026-10-08/rebuild')).json()) as TimeDayWire;
    expect(built.entries).toEqual([
      { key: 'SD-1', hours: 2.5 },
      { key: 'SD-434', hours: 5 },
    ]);
    expect(broadcast).toHaveBeenCalledWith('time-changed', { day: '2026-10-08' });
    expect(((await (await a.request('/api/time/2026-10-08')).json()) as TimeDayWire).titles['SD-1']).toBe('One');
    const list = (await (await a.request('/api/time?from=2026-10-08&to=2026-10-08')).json()) as TimeDaysWire;
    expect(list.days).toEqual([{ day: '2026-10-08', status: 'draft', workday: true, total: 7.5, tickets: 2 }]);
  });

  it('PUT saves your rows, null goes back to the suggestion, dayOff marks a day off', async () => {
    const { a } = app();
    await send(a, 'POST', '/api/time/2026-10-07/rebuild');
    const mine = (await (await send(a, 'PUT', '/api/time/2026-10-07', { entries: [{ key: 'SD-9', hours: 7.5 }] })).json()) as TimeDayWire;
    expect(mine).toMatchObject({ status: 'edited', entries: [{ key: 'SD-9', hours: 7.5 }] });
    const back = (await (await send(a, 'PUT', '/api/time/2026-10-07', { entries: null })).json()) as TimeDayWire;
    expect(back.status).toBe('draft');
    expect(((await (await send(a, 'PUT', '/api/time/2026-10-07', { dayOff: true })).json()) as TimeDayWire).status).toBe('off');
  });

  it('refuses a bad day, bad rows, an empty change, a bad range', async () => {
    const { a } = app();
    expect((await a.request('/api/time/yesterday')).status).toBe(400);
    expect((await send(a, 'PUT', '/api/time/2026-10-07', { entries: [{ key: 'SD-9', hours: 1.1 }] })).status).toBe(400);
    expect((await send(a, 'PUT', '/api/time/2026-10-07', { entries: [{ key: 'nope', hours: 1 }] })).status).toBe(400);
    expect((await send(a, 'PUT', '/api/time/2026-10-07', {})).status).toBe(400);
    expect((await send(a, 'PUT', '/api/time/2026-10-07', { dayOff: 'yes' })).status).toBe(400);
    expect((await a.request('/api/time?from=2026-10-09&to=2026-10-01')).status).toBe(400);
  });
});
