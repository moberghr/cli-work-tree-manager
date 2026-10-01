import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snoozeActive, snoozeFor, snoozeLabel, statusKey } from '../../src/core/snooze.js';
import { inboxRank, wantsYou } from '../../src/core/attention.js';

const done = { attention: { state: 'idle' as const, since: '2026-10-01T10:00:00Z', seen: false }, openReviewThreads: 0 };

describe('snoozeFor', () => {
  it('2 hours; tomorrow 9:00 — or this morning 9:00 when it is still early', () => {
    const afternoon = new Date(2026, 9, 1, 15, 30);
    expect(Date.parse(snoozeFor('2h', done, afternoon).until!)).toBe(afternoon.getTime() + 2 * 3600_000);
    expect(new Date(snoozeFor('tomorrow', done, afternoon).until!)).toEqual(new Date(2026, 9, 2, 9, 0));
    expect(new Date(snoozeFor('tomorrow', done, new Date(2026, 9, 1, 2, 0)).until!)).toEqual(new Date(2026, 9, 1, 9, 0));
    expect(snoozeFor('change', done, afternoon)).toMatchObject({ until: null, statusKey: statusKey(done) });
  });
});

describe('snoozeActive', () => {
  it('a timed one until its time; "until it changes" until the status, or the review threads, change', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    const timed = snoozeFor('2h', done, now);
    expect(snoozeActive(timed, done, now.getTime() + 3600_000)).toBe(true);
    expect(snoozeActive(timed, done, now.getTime() + 3 * 3600_000)).toBe(false);
    const change = snoozeFor('change', done, now);
    expect(snoozeActive(change, done)).toBe(true);
    expect(snoozeActive(change, { ...done, attention: { ...done.attention, state: 'working' as const, since: '2026-10-01T10:05:00Z' } })).toBe(false); // a new turn
    expect(snoozeActive(change, { ...done, openReviewThreads: 1 })).toBe(false); // a reviewer wrote
    expect(snoozeActive(null, done)).toBe(false);
  });

  it('labels: until a time today, tomorrow, a weekday, or until it changes', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(snoozeLabel({ until: new Date(2026, 9, 1, 17, 30).toISOString() }, now)).toMatch(/^until 17:30$|^until 05:30 PM$/);
    expect(snoozeLabel({ until: new Date(2026, 9, 2, 9, 0).toISOString() }, now)).toMatch(/^until tomorrow /);
    expect(snoozeLabel({ until: null }, now)).toBe('until it changes');
  });
});

describe('the inbox with a snoozed session', () => {
  it('its own section, last; it does not want you meanwhile', () => {
    expect(inboxRank({ ...done, snoozed: { until: null } })).toBe(6);
    expect(wantsYou({ ...done, snoozed: { until: null } })).toBe(false);
    expect(wantsYou(done)).toBe(true);
  });
});

describe('snooze routes and the session list', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'snooze-'));
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('POST snoozes, the list shows it while it holds, DELETE ends it; a deleted session takes it along', async () => {
    const { Hono } = await import('hono');
    const { mountStatusRoutes } = await import('../../src/core/status-routes.js');
    const { saveHistory } = await import('../../src/core/history.js');
    const { recordStatusEvent } = await import('../../src/core/session-status.js');
    const { sessionWire } = await import('../../src/core/session-wire.js');
    const { readSnooze } = await import('../../src/core/snooze-store.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { withDb, purgeSessionRows } = await import('../../src/core/db.js');
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt);
    const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString() };
    saveHistory([s]);
    const id = sessionIdFor(s);
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'done' });
    const app = new Hono();
    const events: string[] = [];
    mountStatusRoutes(app, { broadcast: (e) => void events.push(e) });
    const post = (body: unknown) => app.request(`/api/sessions/${id}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ for: 'soon' })).status).toBe(400);
    expect((await post({ for: 'change' })).status).toBe(200);
    expect(events).toContain('sessions-changed');
    const { readSnooze: read } = await import('../../src/core/snooze-store.js');
    expect(sessionWire(s, { snoozeFor: (x) => read(x) }).snoozed).toEqual({ until: null });
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'more' }); // its status changed
    expect(sessionWire(s, { snoozeFor: (x) => read(x) }).snoozed).toBeUndefined();
    await app.request(`/api/sessions/${id}/snooze`, { method: 'DELETE' });
    expect(readSnooze(id)).toBeNull();
    await post({ for: '2h' });
    withDb((d) => purgeSessionRows(d, id));
    expect(readSnooze(id)).toBeNull();
  });
});
