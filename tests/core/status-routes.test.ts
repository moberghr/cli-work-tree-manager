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
import { createPresence, PRESENCE_TTL_MS, type Presence } from '../../src/core/presence.js';

let home: string;
let wt: string;
let session: WorktreeSession;
let events: string[];
let app: Hono;
let clock: number;
let presence: Presence;
let sent: Array<{ e: string; d: unknown }>;

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
  clock = 1_000_000;
  presence = createPresence(() => clock);
  sent = [];
  mountStatusRoutes(app, { broadcast: (e, d) => { events.push(e); sent.push({ e, d }); }, presence });
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
  it('broadcasts before anything else, and does its bookkeeping after replying', async () => {
    const order: string[] = [];
    const a = new Hono();
    mountStatusRoutes(a, { broadcast: (e) => void order.push(e), onStatusChanged: () => void order.push('bookkeeping'), presence });
    await recordStatusEvent(sessionIdFor(session), { kind: 'prompt', prompt: 'go' });
    const res = await a.request('/api/status-changed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: wt }) });
    expect(res.status).toBe(200);
    expect(order).toEqual(['sessions-changed']); // replied: bookkeeping not yet
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['sessions-changed', 'bookkeeping']);
  });

  it('a nudge for a session entering needs_input notifies once and broadcasts', async () => {
    const id = sessionIdFor(session);
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'go' });
    await recordStatusEvent(id, { kind: 'notification', message: 'Claude needs your permission to use Bash' });

    const res = await post('/api/status-changed', { cwd: path.join(wt, 'src') });
    expect(await res.json()).toMatchObject({ matched: true, sessionId: id });
    // No dashboard tab is watching → desktop toast, plus the SSE event.
    expect(events).toEqual(['sessions-changed', 'notify'] /* the windows first: nothing may hold a status back */);
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

describe('notification discipline', () => {
  const id = () => sessionIdFor(session);
  const needsInput = async () => {
    await recordStatusEvent(id(), { kind: 'prompt', prompt: 'go' });
    await recordStatusEvent(id(), { kind: 'notification', message: 'Claude needs your permission to use Bash' });
    await post('/api/status-changed', { cwd: wt });
  };
  const tab = (over: Record<string, unknown> = {}) =>
    post('/api/presence', { clientId: 'tab1', sessionId: null, visible: true, focused: true, canNotify: true, ...over });
  const notifies = () => sent.filter((x) => x.e === 'notify').map((x) => x.d);

  it('stays quiet when a focused tab is showing that session', async () => {
    await tab({ sessionId: id() });
    await needsInput();
    expect(notifies()).toEqual([]);
    expect(notifyDesktop).not.toHaveBeenCalled();
    // The user's own shell hooks still run.
    expect(runStatusHooks).toHaveBeenCalled();
  });

  it('a tab that can notify gets a click-to-jump event instead of the desktop toast', async () => {
    await tab({ sessionId: 'another-session' });
    await needsInput();
    expect(notifies()).toEqual([
      { sessionId: id(), kind: 'needs_input', title: 'Needs your input — api · feat/x', body: 'Claude needs your permission to use Bash' },
    ]);
    expect(notifyDesktop).not.toHaveBeenCalled();
  });

  it('showing the session in a hidden or unfocused tab still notifies', async () => {
    await tab({ sessionId: id(), focused: false });
    await needsInput();
    expect(notifies()).toHaveLength(1);
  });

  it('falls back to the desktop toast when no tab can notify, or tabs went away', async () => {
    await tab({ canNotify: false });
    await needsInput();
    expect(notifyDesktop).toHaveBeenCalledTimes(1);

    notifyDesktop.mockClear();
    await tab({ canNotify: true });
    clock += PRESENCE_TTL_MS + 1; // stopped heart-beating
    await recordStatusEvent(id(), { kind: 'prompt', prompt: 'again' });
    await recordStatusEvent(id(), { kind: 'notification', message: 'Claude needs your permission to use Edit' });
    await post('/api/status-changed', { cwd: wt });
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
  });

  it('a closing tab (sendBeacon, text/plain) drops out at once', async () => {
    await tab({ sessionId: id() });
    const res = await app.request('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ clientId: 'tab1', gone: true }),
    });
    expect(res.status).toBe(200);
    expect(presence.live()).toEqual([]);
    expect((await post('/api/presence', {})).status).toBe(400);
  });
});

describe('POST /api/sessions/:id/answer', () => {
  const bash = { tool: 'Bash', detail: 'npm test -- invoices' };
  const DIALOG = [
    ' Bash command',
    '   npm test -- invoices',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm test commands",
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  let screen: string | null;
  let typed: string[];
  let answerApp: Hono;
  let id: string;

  beforeEach(async () => {
    id = sessionIdFor(session);
    screen = DIALOG;
    typed = [];
    answerApp = new Hono();
    mountStatusRoutes(answerApp, {
      broadcast: (e) => events.push(e),
      presence,
      pty: { screen: async () => screen, write: async (_id, d) => (typed.push(d), true) },
    });
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'add the export' });
    await recordStatusEvent(id, { kind: 'notification', message: 'Claude needs your permission to use Bash', request: bash });
  });
  const answer = (body: unknown) =>
    answerApp.request(`/api/sessions/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('Allow presses Enter on the highlighted Yes and marks the session working', async () => {
    const res = await answer({ answer: 'allow', request: bash });
    expect(res.status).toBe(200);
    expect(typed).toEqual(['\r']);
    expect(readStatus(id)).toMatchObject({ state: 'working', seen: true });
    expect(events).toContain('sessions-changed');
  });

  it('Deny presses Esc and leaves it idle, waiting for you', async () => {
    expect((await answer({ answer: 'deny', request: bash })).status).toBe(200);
    expect(typed).toEqual(['\x1b']);
    expect(readStatus(id)?.state).toBe('idle');
  });

  it('types nothing unless the screen shows exactly what the user was shown', async () => {
    const refused = async (why: RegExp) => {
      const res = await answer({ answer: 'allow', request: bash });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(why);
    };
    screen = '> \n  ? for shortcuts';
    await refused(/no longer on screen/);
    screen = DIALOG.replace('npm test -- invoices', 'git push --force');
    await refused(/about something else/);
    screen = DIALOG.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');
    await refused(/highlighted/);
    screen = null;
    await refused(/not running in the PTY host/);
    expect(typed).toEqual([]);
    expect(readStatus(id)?.state).toBe('needs_input');
  });

  it('refuses a stale click: a different request, or one already answered', async () => {
    const other = await answer({ answer: 'allow', request: { tool: 'Bash', detail: 'rm -rf /' } });
    expect(other.status).toBe(409);
    expect((await answer({ answer: 'allow', request: bash })).status).toBe(200);
    const again = await answer({ answer: 'allow', request: bash });
    expect(again.status).toBe(409); // the double click
    expect(typed).toEqual(['\r']);
  });

  it('validates the body and the session', async () => {
    expect((await answer({ answer: 'maybe', request: bash })).status).toBe(400);
    const res = await answerApp.request('/api/sessions/nope/answer', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
