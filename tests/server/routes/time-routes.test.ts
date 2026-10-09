import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountTimeRoutes } from '../../../src/server/routes/time-routes.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import type { TimeDeps } from '../../../src/core/time/time-days.js';
import type { TimeDaysWire, TimeDayWire } from '../../../src/core/api-types.js';
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
