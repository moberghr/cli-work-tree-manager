import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfigDir } from '../../../src/core/platform/config.js';
import {
  chatsOn,
  finishDeviceLogin,
  graphAccount,
  graphApp,
  graphToken,
  meetingsOn,
  plain,
  signOutGraph,
  startDeviceLogin,
} from '../../../src/core/time/graph.js';

// Each test file has its own HOME (tests/setup): ~/.work/graph-token.json here is a throwaway.
const APP = { clientId: 'client-1', tenantId: 'tenant-1' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('which app signs in', () => {
  it('config first, then the environment; a tenant defaults to organizations; none: why', () => {
    expect(graphApp({ clientId: 'a', tenantId: 't' }, {})).toEqual({ clientId: 'a', tenantId: 't' });
    expect(graphApp(undefined, { GRAPH_CLIENT_ID: 'b' })).toEqual({ clientId: 'b', tenantId: 'organizations' });
    expect(graphApp(undefined, {})).toMatchObject({ why: expect.stringContaining('time.graph.clientId') });
  });
});

describe('the device-code sign-in', () => {
  it('a code to enter; polls while pending, slows down when told, then keeps the tokens (only you can read them)', async () => {
    const bodies: string[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.body) bodies.push(String(init.body));
      if (u.endsWith('/devicecode'))
        return json({
          user_code: 'ABCD-1234',
          device_code: 'dev-1',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        });
      if (u.endsWith('/token')) {
        polls++;
        if (polls === 1) return json({ error: 'authorization_pending' }, 400);
        if (polls === 2) return json({ error: 'slow_down' }, 400);
        return json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 });
      }
      if (u.includes('/me')) return json({ userPrincipalName: 'you@moberg.hr', id: 'me-1' });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const login = await startDeviceLogin(APP, fetchImpl, 0);
    expect(login).toMatchObject({ userCode: 'ABCD-1234', deviceCode: 'dev-1', intervalMs: 5000 });
    expect(bodies[0]).toContain('scope=offline_access+User.Read+Calendars.Read+Chat.Read');
    const waits: number[] = [];
    const account = await finishDeviceLogin(APP, login, { fetchImpl, sleep: async (ms) => void waits.push(ms), now: () => 1 });
    expect(account).toBe('you@moberg.hr');
    expect(waits).toEqual([5000, 5000, 10000]); // slowed down after slow_down
    expect(graphAccount()).toBe('you@moberg.hr');
    const file = path.join(getConfigDir(), 'graph-token.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(await graphToken(APP, fetchImpl, 2)).toBe('acc-1'); // still valid: no refresh
  });

  it('an expired token is refreshed; a refused refresh means signed out in effect (null)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600 });
      return json({ userPrincipalName: 'you@moberg.hr' });
    }) as unknown as typeof fetch;
    expect(await graphToken(APP, fetchImpl, Date.now() + 10 * 3600_000)).toBe('acc-2');
    const refused = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    expect(await graphToken(APP, refused, Date.now() + 100 * 3600_000)).toBeNull();
    signOutGraph();
    expect(graphAccount()).toBeNull();
    expect(await graphToken(APP, fetchImpl)).toBeNull();
  });

  it('a declined or expired code says so', async () => {
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    const declined = (async () =>
      json({ error: 'authorization_declined', error_description: 'The user declined.\nmore' }, 400)) as unknown as typeof fetch;
    await expect(finishDeviceLogin(APP, login, { fetchImpl: declined, sleep: async () => {}, now: () => 1 })).rejects.toThrow(
      'The user declined.',
    );
    await expect(finishDeviceLogin(APP, login, { fetchImpl: declined, sleep: async () => {}, now: () => 99 })).rejects.toThrow('expired');
  });
});

describe('meetings and chats', () => {
  it('meetings: not all day, cancelled, declined or free; in order, with their minutes', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        value: [
          {
            subject: 'PDF refinement',
            start: { dateTime: '2026-10-08T14:00:00.0000000' },
            end: { dateTime: '2026-10-08T15:00:00.0000000' },
          },
          { subject: 'Daily', start: { dateTime: '2026-10-08T09:30:00' }, end: { dateTime: '2026-10-08T09:45:00' } },
          { subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-10-08T00:00:00' }, end: { dateTime: '2026-10-09T00:00:00' } },
          { subject: 'Gone', isCancelled: true, start: { dateTime: '2026-10-08T10:00:00' }, end: { dateTime: '2026-10-08T11:00:00' } },
          {
            subject: 'No',
            responseStatus: { response: 'declined' },
            start: { dateTime: '2026-10-08T11:00:00' },
            end: { dateTime: '2026-10-08T12:00:00' },
          },
          { subject: 'Focus', showAs: 'free', start: { dateTime: '2026-10-08T12:00:00' }, end: { dateTime: '2026-10-08T13:00:00' } },
        ],
      }),
    ) as unknown as typeof fetch;
    expect(await meetingsOn('2026-10-08', 'tok', fetchImpl)).toEqual([
      { subject: 'Daily', start: '09:30', end: '09:45', minutes: 15 },
      { subject: 'PDF refinement', start: '14:00', end: '15:00', minutes: 60 },
    ]);
  });

  it('chats: only ones you wrote in that day, your messages only, as plain text', async () => {
    const day = new Date('2026-10-08T12:00:00');
    const iso = (h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).toISOString();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/me?')) return json({ id: 'me-1' });
      if (u.includes('/me/chats?'))
        return json({
          value: [
            { id: 'c1', topic: 'Payments', lastMessagePreview: { createdDateTime: iso(15) } },
            { id: 'c2', topic: null, chatType: 'oneOnOne', lastMessagePreview: { createdDateTime: iso(10) } },
            { id: 'c3', topic: 'Old', lastMessagePreview: { createdDateTime: '2026-09-01T10:00:00Z' } },
          ],
        });
      if (u.includes('/chats/c1/'))
        return json({
          value: [
            { createdDateTime: iso(15), from: { user: { id: 'me-1' } }, body: { content: '<p>the PDF export &amp; CSV</p>' } },
            { createdDateTime: iso(14), from: { user: { id: 'other' } }, body: { content: 'theirs' } },
          ],
        });
      if (u.includes('/chats/c2/'))
        return json({ value: [{ createdDateTime: iso(10), from: { user: { id: 'other' } }, body: { content: 'x' } }] });
      return json({}, 404);
    }) as unknown as typeof fetch;
    expect(await chatsOn('2026-10-08', 'tok', fetchImpl)).toEqual([{ chat: 'Payments', messages: 1, sample: ['the PDF export & CSV'] }]);
    expect(plain('<div>a&nbsp;<b>b</b></div>')).toBe('a b');
  });
});
