import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebServer, type WebServerHandle } from '../../src/server/web-server.js';
import type { ActivityWire } from '../../src/core/api-types.js';

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

  it('the real one schedules the rest (what the dev server leaves to it)', async () => {
    server = await startWebServer({});
    const kinds = await scheduled(server);
    for (const k of ['pr-watch', 'idle-sleep', 'archive', 'conversations', 'blocks', 'updates']) expect(kinds).toContain(k);
    expect(await (await fetch(`${server.url}api/context`)).json()).not.toHaveProperty('dev');
  }, 60_000);
});
