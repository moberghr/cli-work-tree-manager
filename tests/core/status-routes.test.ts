import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const notifyDesktop = vi.fn();
const runStatusHooks = vi.fn();
vi.mock('../../src/core/notifier.js', () => ({ notifyDesktop: (...a: unknown[]) => notifyDesktop(...a) }));
vi.mock('../../src/core/status-hooks.js', () => ({ runStatusHooks: (...a: unknown[]) => runStatusHooks(...a) }));

import { mountStatusRoutes } from '../../src/core/status-routes.js';
import { saveHistory, type WorktreeSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/web-state.js';
import { readStatus, recordStatusEvent } from '../../src/core/session-status.js';

let home: string;
let wt: string;
let session: WorktreeSession;
let events: string[];
let app: Hono;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'status-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  session = {
    target: 'api', branch: 'feat/x', isGroup: false, paths: [wt],
    createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  saveHistory([session]);
  fs.writeFileSync(path.join(home, '.work', 'config.json'), JSON.stringify({ worktreesRoot: home, notifications: true, statusHooks: [{ on: 'needs_input', command: 'x' }] }));
  events = [];
  app = new Hono();
  mountStatusRoutes(app, { broadcast: (e) => events.push(e) });
  notifyDesktop.mockClear();
  runStatusHooks.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (url: string, body: unknown = {}) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('status routes', () => {
  it('a nudge for a session entering needs_input notifies once and broadcasts', async () => {
    const id = sessionIdFor(session);
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'go' });
    await recordStatusEvent(id, { kind: 'notification', message: 'Claude needs your permission to use Bash' });

    const res = await post('/api/status-changed', { cwd: path.join(wt, 'src') });
    expect(await res.json()).toMatchObject({ matched: true, sessionId: id });
    expect(events).toEqual(['sessions-changed']);
    expect(notifyDesktop).toHaveBeenCalledWith('api · feat/x', 'needs_input', { enabled: true });
    expect(runStatusHooks).toHaveBeenCalledWith('needs_input', wt, 'api · feat/x', [{ on: 'needs_input', command: 'x' }]);

    // The same write nudged twice (hooks racing) must not notify twice.
    await post('/api/status-changed', { cwd: wt });
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
  });

  it('a working → working nudge broadcasts but stays silent', async () => {
    const id = sessionIdFor(session);
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'a' });
    await post('/api/status-changed', { cwd: wt });
    expect(notifyDesktop).not.toHaveBeenCalled();
    expect(events).toEqual(['sessions-changed']);
  });

  it('ignores cwds outside any session and rejects a missing cwd', async () => {
    expect(await (await post('/api/status-changed', { cwd: home })).json()).toMatchObject({ matched: false });
    expect((await post('/api/status-changed', {})).status).toBe(400);
  });

  it('marks a session seen', async () => {
    const id = sessionIdFor(session);
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'done' });
    expect(readStatus(id)?.seen).toBe(false);
    const res = await post(`/api/sessions/${id}/seen`);
    expect(res.status).toBe(200);
    expect(readStatus(id)?.seen).toBe(true);
    expect((await post('/api/sessions/nope/seen')).status).toBe(404);
  });
});
