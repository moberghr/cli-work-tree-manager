import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

// Core is real here; only what starts a program is replaced, so what the route would start can be seen.
const launch = vi.hoisted(() => ({
  startEditor: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  openWithDefaultApp: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  revealInFileManager: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
}));
vi.mock('../../../src/core/platform/launch.js', () => launch);

import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { mountTerminalPathRoutes } from '../../../src/server/routes/terminal-path-routes.js';

let tmp: string;
let script: string;
let session: WorktreeSession;
const app = new Hono();
mountTerminalPathRoutes(app);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-path-routes-'));
  script = path.join(tmp, 'run.sh');
  fs.writeFileSync(script, 'echo hi\n');
  session = {
    target: 'api',
    isGroup: false,
    branch: 'feat/x',
    paths: [tmp],
    createdAt: '2026-11-25T00:00:00Z',
    lastAccessedAt: '2026-11-25T00:00:00Z',
  };
  saveHistory([session]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('POST /api/sessions/:id/terminal-paths/open with the real core', () => {
  it('a plain click on a script goes to the editor, never the default app', async () => {
    const res = await app.request(`/api/sessions/${sessionIdFor(session)}/terminal-paths/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: script, how: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, opened: fs.realpathSync.native(script) });
    expect(launch.openWithDefaultApp).not.toHaveBeenCalled();
    expect(launch.startEditor).toHaveBeenCalledTimes(1);
  });
});
