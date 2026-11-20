import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getConfigDir, getConfigPath } from '../../../src/core/platform/config.js';
import { configSettings } from '../../../src/core/settings/settings-admin.js';
import { mountSettingsRoutes } from '../../../src/server/routes/settings-routes.js';
import { createDemoSettings, mountDemoSettings } from '../../../src/server/demo/demo-settings.js';

let src: string;
beforeAll(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-routes-'));
  fs.mkdirSync(path.join(src, 'api', '.git'), { recursive: true });
  fs.writeFileSync(path.join(src, 'api', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/api.git\n');
});
afterAll(() => fs.rmSync(src, { recursive: true, force: true }));
beforeEach(() => {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({ worktreesRoot: path.join(src, 'worktrees'), repos: { api: path.join(src, 'api') }, groups: {} }),
  );
});

describe('the settings routes: work web’s over config.json, the demo’s in memory, the same answers', () => {
  const apps = () => {
    const events: string[] = [];
    const web = new Hono();
    mountSettingsRoutes(web, { broadcast: (e) => events.push(e), source: configSettings });
    const demo = new Hono();
    mountDemoSettings(
      demo,
      (e) => events.push(e),
      createDemoSettings((a) => (a === 'api' ? '/repos/api' : null)),
    );
    return { events, all: [web, demo] };
  };
  const put = (app: Hono, url: string, body: unknown) =>
    app.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('a change answers the settings after it and is broadcast; a bad one is 400 with why, an unknown one 404', async () => {
    const { events, all } = apps();
    for (const app of all) {
      const ok = await put(app, '/api/settings', { path: 'prWatch.fixCi', value: false });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { values: Record<string, unknown> }).values['prWatch.fixCi']).toBe(false);
      const bad = await put(app, '/api/settings', { path: 'time.dayHours', value: 40 });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(/A workday \(hours\): from 0.5 to 24/);
      expect((await put(app, '/api/settings', { path: 'nope', value: 1 })).status).toBe(404);
      expect((await put(app, '/api/settings', { value: 1 })).status).toBe(400);
      const repo = await put(app, '/api/repos/api/settings', { key: 'reviews', value: 'off' });
      expect(((await repo.json()) as { reviews: string }).reviews).toBe('off');
      expect((await app.request('/api/repos/web/settings')).status).toBe(404);
    }
    expect(events.filter((e) => e === 'settings-changed')).toHaveLength(4);
    expect(events).toContain('repos-changed');
  });
});

describe('a setting work needs, in both servers', () => {
  it('the worktrees folder is refused when emptied — by the real one and the demo alike', async () => {
    const web = new Hono();
    mountSettingsRoutes(web, { broadcast: () => {}, source: configSettings });
    const demo = new Hono();
    mountDemoSettings(
      demo,
      () => {},
      createDemoSettings(() => null),
    );
    for (const app of [web, demo]) {
      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'worktreesRoot', value: null }),
      });
      expect(res.status).toBe(400);
    }
  });
});
