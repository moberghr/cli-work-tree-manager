import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { TerminalPathWire, TerminalPathsWire } from '../../../src/core/api-types.js';

// The routes are a thin front over core: core is mocked, so what reaches it is what is checked.
const core = vi.hoisted(() => ({
  resolveTerminalPath: vi.fn(async (_s: unknown, raw: string): Promise<TerminalPathWire> => ({
    raw,
    path: `/real/${raw}`,
    kind: 'file',
    opens: 'editor',
  })),
  openTerminalPath: vi.fn(
    async (..._a: unknown[]): Promise<{ ok: true; opened: string } | { error: 'missing' | 'ambiguous' | 'failed'; message?: string }> => ({
      ok: true,
      opened: '/real/a.ts',
    }),
  ),
}));
vi.mock('../../../src/core/worktree/terminal-paths.js', () => core);

import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { mountTerminalPathRoutes } from '../../../src/server/routes/terminal-path-routes.js';

const session: WorktreeSession = {
  target: 'api',
  isGroup: false,
  branch: 'feat/x',
  paths: ['/wt/api'],
  createdAt: '2026-11-25T00:00:00Z',
  lastAccessedAt: '2026-11-25T00:00:00Z',
};
const app = new Hono();
mountTerminalPathRoutes(app);

const post = (id: string, what: 'resolve' | 'open', body: unknown) =>
  app.request(`/api/sessions/${id}/terminal-paths/${what}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(() => saveHistory([session]));
beforeEach(() => {
  core.resolveTerminalPath.mockClear();
  core.openTerminalPath.mockClear();
});

describe('POST /api/sessions/:id/terminal-paths/resolve', () => {
  it('answers each path, in the order asked, resolved against the session', async () => {
    // The first one answers last: the order is still the order asked.
    core.resolveTerminalPath.mockImplementationOnce(async (_s, raw) => {
      await new Promise((r) => setTimeout(r, 20));
      return { raw, path: null, kind: 'missing', opens: null };
    });
    const res = await post(sessionIdFor(session), 'resolve', { paths: ['gone.ts', 'b.ts', 'c.html'] });
    expect(res.status).toBe(200);
    const w = (await res.json()) as TerminalPathsWire;
    expect(w.results.map((r) => [r.raw, r.kind])).toEqual([
      ['gone.ts', 'missing'],
      ['b.ts', 'file'],
      ['c.html', 'file'],
    ]);
    expect(core.resolveTerminalPath.mock.calls.map(([s, raw]) => [(s as WorktreeSession).paths, raw])).toEqual([
      [['/wt/api'], 'gone.ts'],
      [['/wt/api'], 'b.ts'],
      [['/wt/api'], 'c.html'],
    ]);
  });

  it('refuses an empty list, more than 50 paths, an empty path or one over 4096 characters', async () => {
    const id = sessionIdFor(session);
    for (const body of [
      {},
      { paths: [] },
      { paths: Array.from({ length: 51 }, (_, i) => `f${i}.ts`) },
      { paths: [''] },
      { paths: ['a'.repeat(4097)] },
      { paths: [42] },
      { paths: 'a.ts' },
    ]) {
      expect((await post(id, 'resolve', body)).status).toBe(400);
    }
    expect((await post(id, 'resolve', { paths: Array.from({ length: 50 }, (_, i) => `f${i}.ts`) })).status).toBe(200);
    expect((await post(id, 'resolve', { paths: ['a'.repeat(4096)] })).status).toBe(200);
  });

  it('an unknown session is 404, and nothing is looked at', async () => {
    const res = await post('nope', 'resolve', { paths: ['a.ts'] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown session' });
    expect(core.resolveTerminalPath).not.toHaveBeenCalled();
  });

  it('is POST only: a GET (which another site could make a browser send) finds no route', async () => {
    expect((await app.request(`/api/sessions/${sessionIdFor(session)}/terminal-paths/resolve?paths=a.ts`)).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/terminal-paths/open', () => {
  it('passes only the path and how on, and answers what was opened', async () => {
    const res = await post(sessionIdFor(session), 'open', {
      path: 'a.ts:3',
      how: 'default',
      // What the browser thinks it is: not taken (core resolves again).
      kind: 'file',
      opens: 'app',
      real: '/etc/passwd',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, opened: '/real/a.ts' });
    expect(core.openTerminalPath).toHaveBeenCalledTimes(1);
    const [s, raw, how, ...rest] = core.openTerminalPath.mock.calls[0];
    expect((s as WorktreeSession).paths).toEqual(['/wt/api']);
    expect([raw, how]).toEqual(['a.ts:3', 'default']);
    expect(rest).toEqual([]);
  });

  it('missing and ambiguous are 404 with that error; a program that did not start is 500 with why', async () => {
    const id = sessionIdFor(session);
    core.openTerminalPath.mockResolvedValueOnce({ error: 'missing' });
    let res = await post(id, 'open', { path: 'gone.ts', how: 'default' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'missing' });

    core.openTerminalPath.mockResolvedValueOnce({ error: 'ambiguous' });
    res = await post(id, 'open', { path: 'server.ts', how: 'editor' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'ambiguous' });

    core.openTerminalPath.mockResolvedValueOnce({ error: 'failed', message: 'could not start code: spawn code ENOENT' });
    res = await post(id, 'open', { path: 'a.ts', how: 'editor' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'could not start code: spawn code ENOENT' });
  });

  it('a failure with no message is 500 with a plain one', async () => {
    core.openTerminalPath.mockResolvedValueOnce({ error: 'failed' });
    const res = await post(sessionIdFor(session), 'open', { path: 'a.ts', how: 'editor' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'could not open it' });
  });

  it('refuses a bad how, an empty path or one over 4096 characters, and starts nothing', async () => {
    const id = sessionIdFor(session);
    for (const body of [
      { path: 'a.ts', how: 'run' },
      { path: 'a.ts' },
      { path: '', how: 'default' },
      { path: 'a'.repeat(4097), how: 'default' },
      { paths: ['a.ts'], how: 'default' },
    ]) {
      expect((await post(id, 'open', body)).status).toBe(400);
    }
    expect(core.openTerminalPath).not.toHaveBeenCalled();
  });

  it('an unknown session is 404, and nothing starts', async () => {
    expect((await post('nope', 'open', { path: 'a.ts', how: 'default' })).status).toBe(404);
    expect(core.openTerminalPath).not.toHaveBeenCalled();
  });
});
