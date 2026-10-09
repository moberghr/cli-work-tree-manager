import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfigDir } from '../../../src/core/platform/config.js';
import {
  CANCELLED,
  chatsOn,
  chatsSince,
  EXPIRED,
  finishDeviceLogin,
  graphAccount,
  graphApp,
  graphProblem,
  graphTime,
  NEW_ACCOUNT,
  graphToken,
  meetingsOn,
  OTHER_APP,
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
      if (u.includes('/me')) return json({ userPrincipalName: 'you@example.com', id: 'me-1' });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const login = await startDeviceLogin(APP, fetchImpl, 0);
    expect(login).toMatchObject({ userCode: 'ABCD-1234', deviceCode: 'dev-1', intervalMs: 5000 });
    expect(bodies[0]).toContain('scope=offline_access+User.Read+Calendars.Read+Chat.Read');
    const waits: number[] = [];
    const account = await finishDeviceLogin(APP, login, { fetchImpl, sleep: async (ms) => void waits.push(ms), now: () => 1 });
    expect(account).toBe('you@example.com');
    expect(waits).toEqual([5000, 5000, 10000]); // slowed down after slow_down
    expect(graphAccount()).toBe('you@example.com');
    const file = path.join(getConfigDir(), 'graph-token.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(await graphToken(APP, fetchImpl, 2)).toBe('acc-1'); // still valid: no refresh
  });

  it('an expired token is refreshed; a refused one throws and is said (connect again) until you do; signed out: null', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600 });
      return json({ userPrincipalName: 'you@example.com' });
    }) as unknown as typeof fetch;
    expect(await graphToken(APP, fetchImpl, Date.now() + 10 * 3600_000)).toBe('acc-2');
    expect(graphProblem(APP)).toBeNull();
    // A server error may pass: thrown, not recorded.
    const down = (async () => json({}, 503)) as unknown as typeof fetch;
    await expect(graphToken(APP, down, Date.now() + 100 * 3600_000)).rejects.toThrow('Microsoft sign-in: 503');
    expect(graphProblem(APP)).toBeNull();
    // Throttled: passes too (the refresh token is still good).
    const throttled = (async () => json({ error: 'temporarily_unavailable' }, 429)) as unknown as typeof fetch;
    await expect(graphToken(APP, throttled, Date.now() + 100 * 3600_000)).rejects.toThrow('Microsoft sign-in: 429');
    expect(graphProblem(APP)).toBeNull();
    const refused = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(graphToken(APP, refused, Date.now() + 100 * 3600_000)).rejects.toThrow(EXPIRED);
    expect(graphAccount()).toBe('you@example.com');
    expect(graphProblem(APP)).toBe(EXPIRED);
    await expect(graphToken(APP, fetchImpl)).rejects.toThrow(EXPIRED); // not tried again
    signOutGraph();
    expect(graphAccount()).toBeNull();
    expect(graphProblem(APP)).toBeNull();
    expect(await graphToken(APP, fetchImpl)).toBeNull();
  });

  it('a refresh keeps the new tokens even when asking who you are fails after it (Microsoft rotated the refresh token)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token')
        ? json({ access_token: 'acc-9', refresh_token: 'ref-9', expires_in: 3600 })
        : json({ userPrincipalName: 'you@example.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await finishDeviceLogin(APP, login, { fetchImpl, sleep: async () => {}, now: () => 1 }); // signed in, as you@example.com
    const meDown = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'acc-10', refresh_token: 'ref-10', expires_in: 3600 });
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await graphToken(APP, meDown, Date.now() + 100 * 3600_000)).toBe('acc-10');
    const file = JSON.parse(fs.readFileSync(path.join(getConfigDir(), 'graph-token.json'), 'utf8')) as Record<string, string>;
    expect(file).toMatchObject({ refreshToken: 'ref-10', accessToken: 'acc-10', account: 'you@example.com' });
    signOutGraph();
  });

  it("a refused refresh after another one already rotated the token: the new tokens stand, no 'connect again'", async () => {
    const ok = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token')
        ? json({ access_token: 'acc-a', refresh_token: 'ref-a', expires_in: 3600 })
        : json({ userPrincipalName: 'you@example.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await finishDeviceLogin(APP, login, { fetchImpl: ok, sleep: async () => {}, now: () => 1 }); // ref-a
    const later = Date.now() + 10 * 3600_000;
    // While this refresh (with ref-a) is in flight, another process refreshes and stores ref-b; ours is then refused.
    const refusedAfterOther = (async (url: string | URL) => {
      if (!String(url).endsWith('/token')) return json({});
      const file = path.join(getConfigDir(), 'graph-token.json');
      const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...cur, refreshToken: 'ref-b', accessToken: 'acc-b', expiresAt: later + 3600_000 }));
      return json({ error: 'invalid_grant' }, 400);
    }) as unknown as typeof fetch;
    expect(await graphToken(APP, refusedAfterOther, later)).toBe('acc-b');
    expect(graphProblem(APP)).toBeNull();
    signOutGraph();
  });

  it("a new sign-in isn't shown as the account signed in before, when Microsoft can't say who it is", async () => {
    const asOld = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token')
        ? json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
        : json({ userPrincipalName: 'old@corp.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await finishDeviceLogin(APP, login, { fetchImpl: asOld, sleep: async () => {}, now: () => 1 });
    expect(graphAccount()).toBe('old@corp.com');
    const meDown = (async (url: string | URL) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
      throw new Error('timeout');
    }) as unknown as typeof fetch;
    await finishDeviceLogin(APP, login, { fetchImpl: meDown, sleep: async () => {}, now: () => 1 }); // connect again, as someone else
    expect(graphAccount()).toBe(NEW_ACCOUNT);
    signOutGraph();
  });

  it('Disconnect while a refresh is under way: the refresh writes nothing back (you stay signed out)', async () => {
    const ok = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token')
        ? json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 })
        : json({ userPrincipalName: 'you@example.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await finishDeviceLogin(APP, login, { fetchImpl: ok, sleep: async () => {}, now: () => 1 });
    const signOutMidway = (async (url: string | URL) => {
      if (String(url).endsWith('/token')) {
        signOutGraph(); // the user clicks Disconnect now
        return json({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600 });
      }
      return json({ userPrincipalName: 'you@example.com' });
    }) as unknown as typeof fetch;
    await graphToken(APP, signOutMidway, Date.now() + 10 * 3600_000);
    expect(graphAccount()).toBeNull();
    expect(fs.existsSync(path.join(getConfigDir(), 'graph-token.json'))).toBe(false);
  });

  it('signed in with another app registration than config names now: connect again', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token')
        ? json({ access_token: 'acc-3', refresh_token: 'ref-3', expires_in: 3600 })
        : json({ userPrincipalName: 'you@example.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await finishDeviceLogin(APP, login, { fetchImpl, sleep: async () => {}, now: () => 1 });
    const other = { clientId: 'client-2', tenantId: 'tenant-1' };
    expect(graphProblem(other)).toBe(OTHER_APP);
    await expect(graphToken(other, fetchImpl)).rejects.toThrow(OTHER_APP);
    signOutGraph();
  });

  it('a sign-in given up on (disconnected, or connecting again) keeps nothing, even when the code is entered after', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/token') ? json({ access_token: 'acc-4', expires_in: 3600 }) : json({ userPrincipalName: 'you@example.com' }),
    ) as unknown as typeof fetch;
    const login = { userCode: 'X', verificationUri: 'u', deviceCode: 'd', expiresAt: 10, intervalMs: 1 };
    await expect(finishDeviceLogin(APP, login, { fetchImpl, sleep: async () => {}, now: () => 1, cancelled: () => true })).rejects.toThrow(
      CANCELLED,
    );
    expect(graphAccount()).toBeNull();
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

  it('meeting times in the zone Graph gives them: local when it honoured ours, UTC when it fell back, an offset when one is there', () => {
    expect(graphTime({ dateTime: '2026-10-08T14:00:00.0000000', timeZone: 'Europe/Zagreb' })).toBe(new Date(2026, 9, 8, 14).getTime());
    expect(graphTime({ dateTime: '2026-10-08T12:00:00.0000000', timeZone: 'UTC' })).toBe(Date.UTC(2026, 9, 8, 12));
    expect(graphTime({ dateTime: '2026-10-08T12:00:00Z' })).toBe(Date.UTC(2026, 9, 8, 12));
    expect(graphTime({ dateTime: '2026-10-08T14:00:00+02:00' })).toBe(Date.UTC(2026, 9, 8, 12));
    expect(graphTime(undefined)).toBeNaN();
  });

  it('a calendar cut at the page limit is a failed read (the day keeps its meetings), not the day', async () => {
    const endless = vi.fn(async () =>
      json({
        value: [{ subject: 'Hold', start: { dateTime: '2026-10-08T09:00:00' }, end: { dateTime: '2026-10-08T09:30:00' } }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/more',
      }),
    ) as unknown as typeof fetch;
    await expect(meetingsOn('2026-10-08', 'tok', endless)).rejects.toThrow('more calendar items than');
  });

  it("a message's text decoded once: shown '&lt;script&gt;' stays that text", () => {
    expect(plain('<p>&amp;lt;script&amp;gt; &amp; more</p>')).toBe('&lt;script&gt; & more');
  });

  it('a calendar with more than a page of items is read to its end', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return String(url).endsWith('/page-2')
        ? json({ value: [{ subject: 'Late', start: { dateTime: '2026-10-08T16:00:00' }, end: { dateTime: '2026-10-08T16:30:00' } }] })
        : json({
            value: [{ subject: 'Early', start: { dateTime: '2026-10-08T09:00:00' }, end: { dateTime: '2026-10-08T09:30:00' } }],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-2',
          });
    }) as unknown as typeof fetch;
    expect((await meetingsOn('2026-10-08', 'tok', fetchImpl)).map((m) => m.subject)).toEqual(['Early', 'Late']);
    expect(urls).toHaveLength(2);
  });

  it("meetings within the day: an offsite over three days is this day's part; time two meetings share counts once", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        value: [
          { subject: 'Offsite', start: { dateTime: '2026-10-07T09:00:00' }, end: { dateTime: '2026-10-09T17:00:00' } },
          { subject: 'Overlapping', start: { dateTime: '2026-10-08T10:00:00' }, end: { dateTime: '2026-10-08T11:00:00' } },
        ],
      }),
    ) as unknown as typeof fetch;
    const m = await meetingsOn('2026-10-08', 'tok', fetchImpl);
    // The offsite holds the whole day (24 h of it); the hour inside it adds nothing and isn't listed.
    expect(m).toEqual([{ subject: 'Offsite', start: '00:00', end: '24:00', minutes: 1440 }]);
    const partial = vi.fn(async () =>
      json({
        value: [
          { subject: 'A', start: { dateTime: '2026-10-08T10:00:00' }, end: { dateTime: '2026-10-08T11:00:00' } },
          { subject: 'B', start: { dateTime: '2026-10-08T10:30:00' }, end: { dateTime: '2026-10-08T12:00:00' } },
        ],
      }),
    ) as unknown as typeof fetch;
    expect((await meetingsOn('2026-10-08', 'tok', partial)).map((x) => [x.subject, x.minutes])).toEqual([
      ['A', 60],
      ['B', 60],
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
    expect(await chatsOn('2026-10-08', 'tok', fetchImpl)).toEqual([
      { id: 'c1', chat: 'Payments', messages: 1, sample: ['the PDF export & CSV'] },
    ]);
    expect(plain('<div>a&nbsp;<b>b</b></div>')).toBe('a b');
  });

  it("Graph doesn't say who you are: the read fails (the day keeps its chats) rather than taking a bot's messages for yours", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('/me?')
        ? json({})
        : json({ value: [{ id: 'c1', topic: 'Bots', lastMessagePreview: { createdDateTime: new Date().toISOString() } }] }),
    ) as unknown as typeof fetch;
    await expect(chatsSince('2026-10-08', 'tok', fetchImpl)).rejects.toThrow('no id for you');
  });

  it("several days in one read, split by day; the keys anyone named, but none of others' words", async () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      asked.push(u);
      if (u.includes('/me?')) return json({ id: 'me-1' });
      if (u.includes('/me/chats?'))
        return json({ value: [{ id: 'c1', topic: 'Payments', lastMessagePreview: { createdDateTime: at(8, 15) } }] });
      if (u.includes('/chats/c1/'))
        return json({
          value: [
            { createdDateTime: at(8, 15), from: { user: { id: 'me-1' } }, body: { content: 'on it' } },
            {
              createdDateTime: at(8, 14),
              from: { user: { id: 'other' } },
              body: { content: 'see <a href="https://x.atlassian.net/browse/OPS-2465">OPS-2465</a>, secret plans' },
            },
            { createdDateTime: at(7, 10), from: { user: { id: 'me-1' } }, body: { content: 'APP-1 done' } },
            { createdDateTime: at(6, 10), from: { user: { id: 'other' } }, body: { content: 'only them that day: APP-9' } },
          ],
        });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const { byDay, incompleteThrough } = await chatsSince('2026-10-06', 'tok', fetchImpl);
    expect(incompleteThrough).toBeNull();
    expect(byDay.get('2026-10-08')).toEqual([{ id: 'c1', chat: 'Payments', messages: 1, sample: ['on it'], mentions: ['OPS-2465'] }]);
    expect(byDay.get('2026-10-07')).toEqual([{ id: 'c1', chat: 'Payments', messages: 1, sample: ['APP-1 done'], mentions: ['APP-1'] }]);
    expect(byDay.has('2026-10-06')).toBe(false); // you didn't write that day
    expect(JSON.stringify([...byDay.values()])).not.toContain('secret plans');
    expect(asked.filter((u) => u.includes('/chats/c1/'))).toHaveLength(1);
  });

  it("an old message edited today (listed first, by last change) doesn't stop the paging before the day's own messages", async () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/me?')) return json({ id: 'me-1' });
      if (u.includes('/me/chats?'))
        return json({ value: [{ id: 'c1', topic: 'Busy', lastMessagePreview: { createdDateTime: at(8, 15) } }] });
      if (u.includes('/chats/c1/'))
        return json({
          value: [
            { createdDateTime: at(1, 10), lastModifiedDateTime: at(8, 16), from: { user: { id: 'other' } }, body: { content: 'edited' } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/c1-2',
        });
      if (u.endsWith('/c1-2'))
        return json({
          value: [{ createdDateTime: at(8, 9), lastModifiedDateTime: at(8, 9), from: { user: { id: 'me-1' } }, body: { content: 'mine' } }],
        });
      return json({}, 404);
    }) as unknown as typeof fetch;
    expect(await chatsOn('2026-10-08', 'tok', fetchImpl)).toEqual([{ id: 'c1', chat: 'Busy', messages: 1, sample: ['mine'] }]);
  });

  it('a chat busier than the pages read: the days it may have missed say so (they keep what they had), the rest stand', async () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
    let page = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/me?')) return json({ id: 'me-1' });
      if (u.includes('/me/chats?'))
        return json({ value: [{ id: 'c1', topic: 'Busy', lastMessagePreview: { createdDateTime: at(8, 15) } }] });
      // Every page has more: today's messages, then the 7th's, and the read stops at the page limit on the 7th.
      page++;
      const t = page < 5 ? at(8, 14, page) : at(7, 14, page);
      return json({
        value: [{ createdDateTime: t, lastModifiedDateTime: t, from: { user: { id: 'me-1' } }, body: { content: `m${page}` } }],
        '@odata.nextLink': `https://graph.microsoft.com/v1.0/c1-${page + 1}`,
      });
    }) as unknown as typeof fetch;
    const r = await chatsSince('2026-10-06', 'tok', fetchImpl);
    expect(r.incompleteThrough).toBe('2026-10-07');
    expect(r.byDay.get('2026-10-08')?.[0]).toMatchObject({ chat: 'Busy', messages: 4 });
    await expect(chatsOn('2026-10-07', 'tok', fetchImpl)).rejects.toThrow('more Teams messages than were read');
  });

  it("a day gone by: chats and messages are read page by page back to the day's start, and no further", async () => {
    const day = new Date('2026-10-08T12:00:00');
    const at = (d: number, h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, h).toISOString();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/me?')) return json({ id: 'me-1' });
      // Chats: page 1 all newer than the day; page 2 has the day's chat, then older; page 3 is never asked for.
      if (u.includes('/me/chats?'))
        return json({
          value: [{ id: 'busy', topic: 'Busy', lastMessagePreview: { createdDateTime: at(1, 15) } }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats-page-2',
        });
      if (u.endsWith('/chats-page-2'))
        return json({
          value: [
            { id: 'same', topic: 'Same day', lastMessagePreview: { createdDateTime: at(0, 16) } },
            { id: 'old', topic: 'Old', lastMessagePreview: { createdDateTime: at(-3, 9) } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats-page-3',
        });
      // The busy chat: a page from the next day, then one reaching into the day, then one before it (not read further).
      if (u.includes('/chats/busy/messages'))
        return json({
          value: [{ createdDateTime: at(1, 15), from: { user: { id: 'me-1' } }, body: { content: 'next day' } }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/busy-2',
        });
      if (u.endsWith('/busy-2'))
        return json({
          value: [
            { createdDateTime: at(0, 17), from: { user: { id: 'me-1' } }, body: { content: 'on the day' } },
            { createdDateTime: at(-1, 17), from: { user: { id: 'me-1' } }, body: { content: 'the day before' } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/busy-3',
        });
      if (u.includes('/chats/same/messages'))
        return json({ value: [{ createdDateTime: at(0, 16), from: { user: { id: 'me-1' } }, body: { content: 'same' } }] });
      return json({}, 404);
    }) as unknown as typeof fetch;
    expect(await chatsOn('2026-10-08', 'tok', fetchImpl)).toEqual([
      { id: 'busy', chat: 'Busy', messages: 1, sample: ['on the day'] },
      { id: 'same', chat: 'Same day', messages: 1, sample: ['same'] },
    ]);
    expect(urls.some((u) => u.endsWith('/chats-page-3') || u.endsWith('/busy-3') || u.includes('/chats/old/'))).toBe(false);
  });
});
