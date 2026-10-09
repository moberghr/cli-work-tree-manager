import { describe, expect, it, vi } from 'vitest';
import {
  planDay,
  postDay,
  tempoClient,
  tempoSetup,
  type PostedWorklog,
  type TempoApi,
  type TempoWorklog,
} from '../../../src/core/time/tempo.js';

const wl = (id: number, issueId: number, seconds: number, startTime = '09:00:00'): TempoWorklog => ({
  tempoWorklogId: id,
  issueId,
  timeSpentSeconds: seconds,
  startDate: '2026-10-08',
  startTime,
});
const ours = (id: number, key: string, issueId: number, seconds: number): PostedWorklog => ({
  tempoWorklogId: id,
  key,
  issueId,
  seconds,
  startTime: '09:00:00',
});

describe("planDay (what to do to Tempo's day)", () => {
  it('first post: every row, one after another from 09:00', () => {
    const p = planDay(
      [
        { key: 'SD-1', issueId: 1, seconds: 9000 },
        { key: 'SD-434', issueId: 434, seconds: 18000 },
      ],
      [],
      [],
    );
    expect(p.add.map((a) => [a.key, a.startTime])).toEqual([
      ['SD-1', '09:00:00'],
      ['SD-434', '11:30:00'],
    ]);
    expect(p.remove).toEqual([]);
  });

  it('posted before and still wanted: kept; changed or taken out: removed and the new one posted after what stays', () => {
    const before = [ours(10, 'SD-1', 1, 9000), ours(11, 'SD-434', 434, 18000)];
    const p = planDay(
      [
        { key: 'SD-1', issueId: 1, seconds: 9000 },
        { key: 'SD-434', issueId: 434, seconds: 14400 },
        { key: 'SD-2', issueId: 2, seconds: 3600 },
      ],
      [wl(10, 1, 9000), wl(11, 434, 18000, '11:30:00')],
      before,
    );
    expect(p.keep.map((k) => k.tempoWorklogId)).toEqual([10]);
    expect(p.remove.map((k) => k.tempoWorklogId)).toEqual([11]);
    expect(p.add.map((a) => [a.key, a.startTime])).toEqual([
      ['SD-434', '11:30:00'],
      ['SD-2', '15:30:00'],
    ]);
  });

  it('your own worklogs are never touched; one that already covers a row means it is not posted twice', () => {
    const p = planDay(
      [
        { key: 'SD-1', issueId: 1, seconds: 3600 },
        { key: 'SD-2', issueId: 2, seconds: 1800 },
      ],
      [wl(50, 1, 3600), wl(51, 99, 1800, '10:00:00')], // by hand: SD-1 an hour (covers the row), another issue after it
      [],
    );
    expect(p.coveredByHand.map((c) => [c.key, c.tempoWorklogId])).toEqual([['SD-1', 50]]);
    expect(p.add.map((a) => [a.key, a.startTime])).toEqual([['SD-2', '10:30:00']]); // after the 1.5 h by hand
    expect(p.otherByHand.map((w) => w.tempoWorklogId)).toEqual([51]);
    expect(p.remove).toEqual([]);
  });

  it('an issue you logged by hand for another time: its row is not posted (Tempo would have it twice), and says why', async () => {
    const p = planDay(
      [
        { key: 'PAY-1', issueId: 1, seconds: 3 * 3600 },
        { key: 'SD-2', issueId: 2, seconds: 3600 },
      ],
      [wl(50, 1, 2 * 3600)],
      [],
    );
    expect(p.differsByHand).toEqual([{ key: 'PAY-1', issueId: 1, seconds: 10800, handSeconds: 7200 }]);
    expect(p.add.map((a) => a.key)).toEqual(['SD-2']);
    expect(p.otherByHand).toEqual([]);
    const api = { list: vi.fn(async () => [wl(50, 1, 2 * 3600)]), create: vi.fn(async () => 9), remove: vi.fn(async () => {}) };
    const r = await postDay(
      '2026-10-08',
      [
        { key: 'PAY-1', hours: 3 },
        { key: 'SD-2', hours: 1 },
      ],
      [],
      { api, accountId: 'a', issueId: async (k) => ({ 'PAY-1': 1, 'SD-2': 2 })[k] ?? null },
    );
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(r.failed).toEqual([{ key: 'PAY-1', error: 'you logged 2 h on it by hand in Tempo (this row: 3 h): change one of them' }]);
  });

  it('a worklog work posted and you then changed by hand in Tempo is yours: never kept as if unchanged, never deleted', () => {
    // Posted PAY-12 at 2 h; you made it 3 h in Tempo.
    const edited = planDay([{ key: 'PAY-12', issueId: 12, seconds: 7200 }], [wl(10, 12, 3 * 3600)], [ours(10, 'PAY-12', 12, 7200)]);
    expect(edited.keep).toEqual([]);
    expect(edited.remove).toEqual([]);
    expect(edited.differsByHand.map((d) => [d.key, d.handSeconds])).toEqual([['PAY-12', 10800]]);
    // The row changed instead: still not deleted.
    const changed = planDay([{ key: 'PAY-12', issueId: 12, seconds: 3600 }], [wl(10, 12, 3 * 3600)], [ours(10, 'PAY-12', 12, 7200)]);
    expect(changed.remove).toEqual([]);
  });

  it("Jira can't give an issue's id now: the id work posted it under before, so its worklog isn't taken for unwanted", async () => {
    const api = { list: vi.fn(async () => [wl(10, 12, 7200)]), create: vi.fn(async () => 9), remove: vi.fn(async () => {}) };
    const r = await postDay('2026-10-08', [{ key: 'PAY-12', hours: 2 }], [ours(10, 'PAY-12', 12, 7200)], {
      api,
      accountId: 'a',
      issueId: async () => Promise.reject(new Error('acli: signed out')),
    });
    expect(api.remove).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kept: 1, posted: 0, failed: [] });
  });

  it('new rows start where what stays ends, by its real start time (not 09:00 plus the hours)', () => {
    // By hand: an hour at 09:00 and two hours at 13:00 → the new row starts at 15:00, overlapping nothing.
    const p = planDay([{ key: 'SD-2', issueId: 2, seconds: 10800 }], [wl(50, 99, 3600), wl(51, 98, 7200, '13:00:00')], []);
    expect(p.add.map((a) => [a.key, a.startTime])).toEqual([['SD-2', '15:00:00']]);
  });

  it('never a start at midnight or later (Tempo refuses it): a late row ends at 24:00', () => {
    const p = planDay(
      [
        { key: 'SD-1', issueId: 1, seconds: 4 * 3600 },
        { key: 'SD-2', issueId: 2, seconds: 3 * 3600 },
      ],
      [wl(50, 99, 12 * 3600, '09:00:00')], // a 12 h day by hand already: ends at 21:00
      [],
    );
    expect(p.add.map((a) => a.startTime)).toEqual(['20:00:00', '21:00:00']);
  });

  it('a worklog work posted that was deleted in Tempo is forgotten (not deleted again), and its row posted', () => {
    const p = planDay([{ key: 'SD-1', issueId: 1, seconds: 3600 }], [], [ours(10, 'SD-1', 1, 3600)]);
    expect(p.remove).toEqual([]);
    expect(p.add.map((a) => a.key)).toEqual(['SD-1']);
  });
});

describe('postDay', () => {
  const api = (inTempo: TempoWorklog[] = []) => {
    let next = 100;
    return {
      list: vi.fn(async () => inTempo),
      create: vi.fn(async () => next++),
      remove: vi.fn(async () => {}),
    } satisfies TempoApi;
  };

  it('posts the rows by issue id, as you, on the day; reports and returns what work posted', async () => {
    const a = api();
    const r = await postDay(
      '2026-10-08',
      [
        { key: 'SD-1', hours: 2.5 },
        { key: 'SD-434', hours: 5 },
      ],
      [],
      { api: a, accountId: 'acc-1', issueId: async (k) => ({ 'SD-1': 1, 'SD-434': 434 })[k] ?? null },
    );
    expect(a.list).toHaveBeenCalledWith('acc-1', '2026-10-08');
    expect(a.create).toHaveBeenCalledWith({
      issueId: 1,
      timeSpentSeconds: 9000,
      startDate: '2026-10-08',
      startTime: '09:00:00',
      authorAccountId: 'acc-1',
    });
    expect(r).toMatchObject({ posted: 2, removed: 0, kept: 0, failed: [] });
    expect(r.ours.map((o) => [o.tempoWorklogId, o.key])).toEqual([
      [100, 'SD-1'],
      [101, 'SD-434'],
    ]);
  });

  it('an issue Jira does not know, or a call that fails, is reported and the rest goes on; a delete that fails keeps it as ours', async () => {
    const a = api([wl(10, 7, 3600)]);
    a.create.mockRejectedValueOnce(new Error('Tempo post: 400 bad'));
    a.remove.mockRejectedValueOnce(new Error('Tempo delete: 500'));
    const r = await postDay(
      '2026-10-08',
      [
        { key: 'SD-1', hours: 1 },
        { key: 'SD-2', hours: 1 },
        { key: 'SD-NOPE', hours: 1 },
      ],
      [ours(10, 'SD-7', 7, 3600)],
      { api: a, accountId: 'acc-1', issueId: async (k) => ({ 'SD-1': 1, 'SD-2': 2 })[k] ?? null },
    );
    expect(r.failed.map((f) => f.key)).toEqual(['SD-NOPE', 'SD-7', 'SD-1']);
    expect(r.posted).toBe(1);
    expect(r.ours.map((o) => o.key).sort()).toEqual(['SD-2', 'SD-7']);
    expect(r.stuck.map((o) => o.key)).toEqual(['SD-7']);
  });

  it("a ticket whose old worklog couldn't be removed gets no new one (Tempo would have both)", async () => {
    // SD-1 was posted at 2 h, now wanted at 3 h; the delete fails.
    const a = api([wl(10, 1, 7200)]);
    a.remove.mockRejectedValueOnce(new Error('Tempo delete: 429'));
    const r = await postDay(
      '2026-10-08',
      [
        { key: 'SD-1', hours: 3 },
        { key: 'SD-2', hours: 1 },
      ],
      [ours(10, 'SD-1', 1, 7200)],
      { api: a, accountId: 'acc-1', issueId: async (k) => ({ 'SD-1': 1, 'SD-2': 2 })[k] ?? null },
    );
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(a.create).toHaveBeenCalledWith(expect.objectContaining({ issueId: 2 }));
    expect(r.failed).toEqual([{ key: 'SD-1', error: 'Tempo delete: 429' }]);
    expect(r.stuck.map((o) => [o.key, o.seconds])).toEqual([['SD-1', 7200]]);
    expect(r.ours.map((o) => o.key).sort()).toEqual(['SD-1', 'SD-2']);
  });
});

describe('tempoSetup and the client', () => {
  it('needs a token (from the env, never config) and your account id', () => {
    expect(tempoSetup(undefined, {})).toMatchObject({ ready: false, why: expect.stringContaining('TEMPO_API_TOKEN') });
    expect(tempoSetup(undefined, { TEMPO_API_TOKEN: 't' })).toMatchObject({ ready: false, why: expect.stringContaining('account id') });
    expect(tempoSetup({ accountId: 'a' }, { TEMPO_API_TOKEN: 't' })).toEqual({ ready: true, token: 't', accountId: 'a' });
    expect(tempoSetup({ tokenEnv: 'MY_TEMPO' }, { MY_TEMPO: 't', JIRA_ACCOUNT_ID: 'b' })).toEqual({
      ready: true,
      token: 't',
      accountId: 'b',
    });
  });

  it('lists a day page by page, posts and deletes with the bearer token; a 404 delete is fine', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (String(url).includes('/user/') && !String(url).includes('page2'))
        return json({
          results: [{ tempoWorklogId: 1, issue: { id: 7 }, timeSpentSeconds: 60, startDate: '2026-10-08', startTime: '09:00:00' }],
          metadata: { next: 'https://api.tempo.io/4/worklogs/user/acc?page2' },
        });
      if (String(url).includes('page2'))
        return json({ results: [{ tempoWorklogId: 2, issue: { id: 8 }, timeSpentSeconds: 60 }], metadata: {} });
      if (init?.method === 'POST') return json({ tempoWorklogId: 42 });
      if (init?.method === 'DELETE') return new Response('', { status: 404 });
      return json({}, 500);
    }) as unknown as typeof fetch;
    const c = tempoClient('secret', fetchImpl);
    expect((await c.list('acc', '2026-10-08')).map((w) => w.tempoWorklogId)).toEqual([1, 2]);
    expect(calls[0].url).toBe('https://api.tempo.io/4/worklogs/user/acc?from=2026-10-08&to=2026-10-08&limit=1000');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(
      await c.create({ issueId: 7, timeSpentSeconds: 60, startDate: '2026-10-08', startTime: '09:00:00', authorAccountId: 'acc' }),
    ).toBe(42);
    await expect(c.remove(5)).resolves.toBeUndefined();
  });

  it('a refusal says what Tempo said', async () => {
    const c = tempoClient('t', (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch);
    await expect(c.list('acc', '2026-10-08')).rejects.toThrow('Tempo list: 401 Unauthorized');
  });
});
