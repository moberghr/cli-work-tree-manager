import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { markDiffSeen, readDiffSeen } from '../../../src/core/diff/diff-seen.js';
import { LOOK_JOIN_MS, MAX_LOOKS, nextSeen } from '../../../src/core/diff/diff-looks.js';
import { mountDiffSeenRoutes } from '../../../src/server/routes/diff-seen-routes.js';
import { removeSession, saveHistory } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

const now = new Date().toISOString();
const session = { target: 'api', branch: 'feat/seen', isGroup: false, paths: ['/wt/seen'], createdAt: now, lastAccessedAt: now };
const id = sessionIdFor(session);

describe('how far you have looked at a diff (state.db)', () => {
  it('only moves forward: a window still showing an older diff never takes back what you saw', () => {
    expect(readDiffSeen(id)).toBeNull();
    expect(markDiffSeen(id, 3, new Date('2026-10-04T10:00:00Z'))).toEqual({ checkpointId: 3, at: '2026-10-04T10:00:00.000Z' });
    expect(markDiffSeen(id, 2).checkpointId).toBe(3);
    expect(markDiffSeen(id, 5).checkpointId).toBe(5);
    expect(readDiffSeen(id)?.checkpointId).toBe(5);
  });

  it('routes: GET reads, POST marks; unknown session 404, a bad body 400', async () => {
    saveHistory([session]);
    const app = new Hono();
    mountDiffSeenRoutes(app);
    const post = (body: unknown, sid = id) =>
      app.request(`/api/sessions/${sid}/diff-seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ checkpointId: 7 })).status).toBe(200);
    expect(
      ((await (await app.request(`/api/sessions/${id}/diff-seen`)).json()) as { seen: { checkpointId: number } }).seen.checkpointId,
    ).toBe(7);
    expect((await post({ checkpointId: 'x' })).status).toBe(400);
    expect((await post({ checkpointId: -1 })).status).toBe(400);
    expect((await post({ checkpointId: 1 }, 'nope')).status).toBe(404);
  });

  it('keeps your looks in the same record: the second look on is recorded, and read back', () => {
    const sid = 'looks-store';
    markDiffSeen(sid, 2, new Date('2026-10-04T10:00:00Z'));
    markDiffSeen(sid, 5, new Date('2026-10-04T12:00:00Z'));
    expect(readDiffSeen(sid)).toEqual({
      checkpointId: 5,
      at: '2026-10-04T12:00:00.000Z',
      looks: [{ from: 2, to: 5, startedAt: '2026-10-04T12:00:00.000Z', at: '2026-10-04T12:00:00.000Z' }],
    });
  });

  it('goes with the session', async () => {
    saveHistory([session]);
    markDiffSeen(id, 1);
    await removeSession(session.target, session.branch);
    expect(readDiffSeen(id)).toBeNull();
  });
});

describe('your looks (nextSeen, pure)', () => {
  const t = (min: number) => new Date(Date.parse('2026-10-04T10:00:00Z') + min * 60_000);

  it('the first look records none (nothing to show "since"); each move after it is a look from where it was', () => {
    const first = nextSeen(null, 3, t(0));
    expect(first.looks).toBeUndefined();
    const second = nextSeen(first, 6, t(60));
    expect(second.looks).toEqual([{ from: 3, to: 6, startedAt: t(60).toISOString(), at: t(60).toISOString() }]);
    expect(nextSeen(second, 6, t(61))).toBe(second); // not further: unchanged
    expect(nextSeen(second, 4, t(61))).toBe(second);
  });

  it('moves close together are one sitting: the look grows; after a pause a new one starts', () => {
    let seen = nextSeen(nextSeen(null, 1, t(0)), 2, t(30));
    seen = nextSeen(seen, 4, t(35)); // you stayed while Claude finished two more turns
    expect(seen.looks).toEqual([{ from: 1, to: 4, startedAt: t(30).toISOString(), at: t(35).toISOString() }]);
    seen = nextSeen(seen, 5, t(35 + LOOK_JOIN_MS / 60_000 + 1));
    expect(seen.looks?.map((l) => [l.from, l.to])).toEqual([
      [1, 4],
      [4, 5],
    ]);
  });

  it(`keeps the last ${MAX_LOOKS}`, () => {
    let seen = nextSeen(null, 0, t(0));
    for (let i = 1; i <= MAX_LOOKS + 5; i++) seen = nextSeen(seen, i, t(i * 60));
    expect(seen.looks).toHaveLength(MAX_LOOKS);
    expect(seen.looks?.at(-1)).toMatchObject({ from: MAX_LOOKS + 4, to: MAX_LOOKS + 5 });
  });

  it('a re-baselined scope (turns counted from 1 again): the mark starts over, no look across it', () => {
    const before = nextSeen(nextSeen(null, 5, t(0), '2026-10-04T09:00:00Z'), 12, t(60), '2026-10-04T10:00:00Z');
    expect(before.looks).toHaveLength(1);
    // A rebase brought main in: turn 3 is newer than the marked turn 12.
    const after = nextSeen(before, 3, t(120), '2026-10-04T11:00:00Z');
    expect(after).toMatchObject({ checkpointId: 3, ts: '2026-10-04T11:00:00Z' });
    expect(after.looks).toEqual(before.looks); // kept (they hide themselves: their turns' times no longer match)
    // Same numbering, an older window: still no going back.
    expect(nextSeen(before, 11, t(130), '2026-10-04T09:30:00Z')).toBe(before);
    // Each look keeps its turns' times.
    expect(before.looks?.[0]).toMatchObject({ fromTs: '2026-10-04T09:00:00Z', toTs: '2026-10-04T10:00:00Z' });
  });
});
