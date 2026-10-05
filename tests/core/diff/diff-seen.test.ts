import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { markDiffSeen, readDiffSeen } from '../../../src/core/diff/diff-seen.js';
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

  it('goes with the session', async () => {
    saveHistory([session]);
    markDiffSeen(id, 1);
    await removeSession(session.target, session.branch);
    expect(readDiffSeen(id)).toBeNull();
  });
});
