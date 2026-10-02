import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionControlRoutes, type ControlDeps } from '../../src/core/session-control-routes.js';
import { saveHistory, type WorktreeSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';

/** POST …/send, …/agent/start, …/agent/stop and GET …/screen, with the PTY host and comment route faked. */

const s: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/x'], createdAt: 'x', lastAccessedAt: 'x' };
const id = sessionIdFor(s);

function app(over: Partial<ControlDeps> = {}) {
  const events: string[] = [];
  const deps: Partial<ControlDeps> = {
    post: vi.fn(async () => null),
    hostRuns: () => false,
    runningOutside: () => false,
    start: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    screen: vi.fn(async () => '❯ Done.'),
    state: () => 'idle',
    unsafe: () => false,
    archived: () => false,
    ...over,
  };
  const a = new Hono();
  mountSessionControlRoutes(a, { broadcast: (e) => events.push(e), deps });
  return { a, deps, events };
}
const post = (a: Hono, url: string, body: unknown = {}) => a.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/sessions/:id/send', () => {
  it('queues the message, says how it went, and tells the dashboard', async () => {
    saveHistory([s]);
    const { a, deps, events } = app({ hostRuns: () => true, post: vi.fn(async () => 'typed' as const) });
    const res = await post(a, `/api/sessions/${id}/send`, { text: 'Run the tests' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ how: 'typed', sentAt: expect.any(String) });
    expect(deps.post).toHaveBeenCalledWith(id, 'Run the tests');
    expect(events).toContain('sessions-changed');
  });

  it('refusals keep their reason; an unknown session is 404; a failed queue is 502', async () => {
    saveHistory([s]);
    expect((await post(app().a, '/api/sessions/nope/send', { text: 'x' })).status).toBe(404);
    expect((await post(app().a, `/api/sessions/${id}/send`, {})).status).toBe(400);
    const unsafe = await post(app({ unsafe: () => true }).a, `/api/sessions/${id}/send`, { text: 'x' });
    expect(unsafe.status).toBe(409);
    expect(await unsafe.json()).toMatchObject({ error: expect.stringContaining('--force') });
    expect((await post(app({ unsafe: () => true }).a, `/api/sessions/${id}/send`, { text: 'x', force: true })).status).toBe(200);
    const broken = await post(app({ post: async () => { throw new Error('queueing the message failed (500)'); } }).a, `/api/sessions/${id}/send`, { text: 'x' });
    expect(broken.status).toBe(502);
  });
});

describe('POST /api/sessions/:id/agent/start | stop', () => {
  it('start: resumes it; already running says so; archived and unknown are refused', async () => {
    saveHistory([s]);
    const { a, deps } = app();
    expect(await (await post(a, `/api/sessions/${id}/agent/start`)).json()).toEqual({ how: 'started' });
    expect(deps.resume).toHaveBeenCalledWith(id);
    expect(await (await post(app({ hostRuns: () => true }).a, `/api/sessions/${id}/agent/start`)).json()).toEqual({ how: 'running' });
    expect((await post(app({ resume: async () => false }).a, `/api/sessions/${id}/agent/start`)).status).toBe(502);
    expect((await post(a, '/api/sessions/nope/agent/start')).status).toBe(404);
    saveHistory([{ ...s, archivedAt: '2026-10-01T00:00:00Z' }]);
    expect((await post(a, `/api/sessions/${id}/agent/start`)).status).toBe(409);
  });

  it('start: never a second Claude on a conversation running outside work, unless forced', async () => {
    saveHistory([s]);
    const outside = app({ runningOutside: () => true });
    const res = await post(outside.a, `/api/sessions/${id}/agent/start`);
    expect(res.status).toBe(409);
    expect(outside.deps.resume).not.toHaveBeenCalled();
    expect(await (await post(outside.a, `/api/sessions/${id}/agent/start`, { force: true })).json()).toEqual({ how: 'started' });
  });

  it('stop: stops a host Claude; nothing running says so; one outside work is stopped there', async () => {
    saveHistory([s]);
    const running = app({ hostRuns: () => true });
    expect(await (await post(running.a, `/api/sessions/${id}/agent/stop`)).json()).toEqual({ how: 'stopped' });
    expect(running.deps.stop).toHaveBeenCalledWith(id);
    expect(await (await post(app().a, `/api/sessions/${id}/agent/stop`)).json()).toEqual({ how: 'not-running' });
    expect((await post(app({ runningOutside: () => true }).a, `/api/sessions/${id}/agent/stop`)).status).toBe(409);
  });
});

describe('GET /api/sessions/:id/screen', () => {
  it('the terminal as text when the host runs it; null otherwise — and it never starts one', async () => {
    saveHistory([s]);
    expect(await (await app({ hostRuns: () => true }).a.request(`/api/sessions/${id}/screen`)).json()).toEqual({ text: '❯ Done.' });
    const idle = app();
    expect(await (await idle.a.request(`/api/sessions/${id}/screen`)).json()).toEqual({ text: null });
    expect(idle.deps.screen).not.toHaveBeenCalled();
    expect(idle.deps.resume).not.toHaveBeenCalled();
    expect((await idle.a.request('/api/sessions/nope/screen')).status).toBe(404);
  });
});
