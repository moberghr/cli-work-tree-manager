import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebServer, type WebServerHandle } from '../../src/server/web-server.js';
import type { ActivityWire, UpdateWire } from '../../src/core/api-types.js';
import { saveHistory, type WorktreeSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';

/**
 * The dev server (`work web --dev`) beside the real work web, on the same
 * data: it shows everything, but none of the jobs that act run in it — they
 * would run twice. What a server has scheduled is what its Activity panel
 * lists.
 */

const hasBuild = fs.existsSync(path.resolve(__dirname, '../../dist/web/index.html'));
let home: string;
let server: WebServerHandle | null = null;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dev-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(async () => {
  await server?.stop();
  server = null;
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const scheduled = async (s: WebServerHandle) =>
  ((await (await fetch(`${s.url}api/activity`)).json()) as ActivityWire).schedules.map((x) => x.kind).sort();

describe.skipIf(!hasBuild)('work web --dev (startWebServer dev)', () => {
  it('says it is the dev server, and schedules only the look-only PR check', async () => {
    server = await startWebServer({ dev: true });
    expect(await (await fetch(`${server.url}api/context`)).json()).toMatchObject({ mode: 'dashboard', dev: true });
    expect(await scheduled(server)).toEqual(['pr-watch']);
  }, 60_000);

  it("never offers the installed app's update, nor asks the app for one (its Restart would close the installed app)", async () => {
    // The installed app has downloaded 2.9.0 and is running (its pid: this one, alive).
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.work', 'desktop-update.json'),
      JSON.stringify({ appVersion: '2.0.2', state: 'ready', target: '2.9.0', pid: process.pid }),
    );
    server = await startWebServer({ dev: true });
    const w = (await (await fetch(`${server.url}api/updates`)).json()) as UpdateWire;
    expect(w).toMatchObject({ desktop: null, available: null });
    for (const route of ['check', 'restart'])
      expect((await fetch(`${server.url}api/updates/${route}`, { method: 'POST' })).status).toBe(409);
    expect(fs.existsSync(path.join(home, '.work', 'desktop-request.json'))).toBe(false);
  }, 60_000);

  it('a block set from its dashboard runs no sweep there (gh, notifications, notes are the real one’s)', async () => {
    const s: WorktreeSession = {
      target: 'api',
      branch: 'feat/x',
      isGroup: false,
      paths: [home],
      createdAt: 'x',
      lastAccessedAt: new Date().toISOString(),
    };
    saveHistory([s]);
    server = await startWebServer({ dev: true });
    const r = await fetch(`${server.url}api/sessions/${sessionIdFor(s)}/blocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'pr', url: 'https://github.com/o/r/pull/1' }),
    });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    const act = (await (await fetch(`${server.url}api/activity`)).json()) as ActivityWire;
    expect([...act.running, ...act.recent].map((x) => x.kind)).not.toContain('blocks');
  }, 60_000);

  it('the real one schedules the rest (what the dev server leaves to it)', async () => {
    server = await startWebServer({});
    const kinds = await scheduled(server);
    for (const k of ['pr-watch', 'idle-sleep', 'archive', 'conversations', 'blocks', 'updates']) expect(kinds).toContain(k);
    expect(await (await fetch(`${server.url}api/context`)).json()).not.toHaveProperty('dev');
  }, 60_000);
});
