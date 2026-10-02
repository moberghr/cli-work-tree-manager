import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveHistory, type WorktreeSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { disposeAllScopes } from '../../src/core/scope-manager.js';
import { startWebServer, type WebServerHandle } from '../../src/core/web-server.js';

/**
 * The session-control routes on the real server (wired with the real PTY
 * pool, comment route and session store). Only paths that start no Claude:
 * the refusals, a stop with nothing running, a screen with no terminal.
 */

let home: string;
let server: WebServerHandle;
const at = (route: string) => server.url.replace(/\/$/, '') + route;
const post = (route: string, body: unknown = {}) => fetch(at(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const session = (branch: string, over: Partial<WorktreeSession> = {}): WorktreeSession => {
  const wt = path.join(home, 'wt', branch.replace('/', '-'));
  fs.mkdirSync(wt, { recursive: true });
  return { target: 'api', branch, isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x', ...over };
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'control-real-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  saveHistory([session('feat/live'), session('feat/old', { archivedAt: '2026-10-01T00:00:00Z' }), session('feat/unsafe', { launchedUnsafe: true })]);
  server = await startWebServer({ lean: true });
}, 60_000);
afterEach(async () => {
  await server.stop();
  disposeAllScopes();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const id = (branch: string) => sessionIdFor({ target: 'api', branch });

describe('session control on the real server', () => {
  it('send: an archived session and an --unsafe one are refused with the reason; nothing is queued for them', async () => {
    const old = await post(`/api/sessions/${id('feat/old')}/send`, { text: 'x' });
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: expect.stringContaining('archived') });
    const unsafe = await post(`/api/sessions/${id('feat/unsafe')}/send`, { text: 'x' });
    expect(unsafe.status).toBe(409);
    expect(await unsafe.json()).toMatchObject({ error: expect.stringContaining('--unsafe') });
    const comments = (await (await fetch(at(`/api/sessions/${id('feat/unsafe')}/comments`))).json()) as { comments: unknown[] };
    expect(comments.comments).toEqual([]);
    expect((await post('/api/sessions/nope/send', { text: 'x' })).status).toBe(404);
  });

  it('stop with nothing running, screen with no terminal, start of an archived one', async () => {
    expect(await (await post(`/api/sessions/${id('feat/live')}/agent/stop`)).json()).toEqual({ how: 'not-running' });
    expect(await (await fetch(at(`/api/sessions/${id('feat/live')}/screen`))).json()).toEqual({ text: null });
    expect((await post(`/api/sessions/${id('feat/old')}/agent/start`)).status).toBe(409);
  });
});
