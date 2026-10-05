import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSetupRoutes } from '../../../src/server/routes/setup-routes.js';
import { loadConfig } from '../../../src/core/platform/config.js';
import type { SetupWire, ToolCheck } from '../../../src/core/api-types.js';

let home: string;
let app: Hono;
let events: string[];
let checks: number;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  events = [];
  checks = 0;
  app = new Hono();
  const tools = async (): Promise<ToolCheck[]> => (checks++, [{ id: 'git', label: 'git', needed: true, ok: true, detail: 'git 2' }]);
  mountSetupRoutes(app, { broadcast: (e) => void events.push(e), tools });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
const get = async (q = '') => (await (await app.request(`/api/setup${q}`)).json()) as SetupWire;
const post = (body: unknown) =>
  app.request('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('the Welcome page routes', () => {
  it('GET says where setup stands; the tool checks are kept a while, ?fresh=1 asks again', async () => {
    expect(await get()).toMatchObject({ configured: false, repos: 0, tools: [{ id: 'git', ok: true }] });
    await get();
    expect(checks).toBe(1);
    await get('?fresh=1');
    expect(checks).toBe(2);
  });

  it('POST sets the folders (making config.json), tells every window; a bad one is 400 with the reason', async () => {
    expect((await post({ worktreesRoot: path.join(home, 'wt'), reposFolder: home })).status).toBe(200);
    expect(loadConfig()).toMatchObject({ worktreesRoot: path.join(home, 'wt'), scanRoots: [home] });
    expect(events).toEqual(['repos-changed']);
    expect((await get()).configured).toBe(true);
    const bad = await post({ worktreesRoot: 'relative', reposFolder: home });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/isn't a full path/);
    expect((await post({ worktreesRoot: 1 })).status).toBe(400);
  });
});
