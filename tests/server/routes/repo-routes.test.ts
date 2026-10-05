import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfigDir, getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import { saveHistory } from '../../../src/core/sessions/history.js';
import { mountRepoRoutes } from '../../../src/server/routes/repo-routes.js';
import type { ReposWire } from '../../../src/core/api-types.js';

let src: string;
beforeAll(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-routes-'));
  for (const r of ['api', 'web', 'tool']) fs.mkdirSync(path.join(src, r, '.git'), { recursive: true });
});
afterAll(() => fs.rmSync(src, { recursive: true, force: true }));

let events: string[];
let app: Hono;
beforeEach(() => {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({ worktreesRoot: path.join(src, 'worktrees'), repos: { api: path.join(src, 'api') }, groups: {}, copyFiles: [] }),
  );
  saveHistory([]);
  events = [];
  app = new Hono();
  mountRepoRoutes(app, { broadcast: (e) => void events.push(e) }); // no workBin: no instructions child in tests
});
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const inventory = async () => (await (await app.request('/api/repos')).json()) as ReposWire;

describe('the Repos page routes', () => {
  it('GET lists what is enrolled and what is found next to it', async () => {
    const inv = await inventory();
    expect(inv.repos.map((r) => `${r.folder}:${r.status}`)).toEqual(['api:enrolled', 'tool:new', 'web:new']);
  });

  it('enrol, ignore, remove — each tells every window (repos-changed); a bad one says why', async () => {
    expect((await send('POST', '/api/repos', { alias: 'web', path: path.join(src, 'web') })).status).toBe(200);
    expect((await send('POST', '/api/repos/ignore', { path: path.join(src, 'tool'), ignored: true })).status).toBe(200);
    expect((await inventory()).repos.map((r) => `${r.folder}:${r.status}`)).toEqual(['api:enrolled', 'tool:ignored', 'web:enrolled']);
    const bad = await send('POST', '/api/repos', { alias: 'web', path: path.join(src, 'tool') });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/already the alias/);
    expect((await send('DELETE', '/api/repos/web')).status).toBe(200);
    expect(loadConfig()!.repos.web).toBeUndefined();
    expect(events).toEqual(['repos-changed', 'repos-changed', 'repos-changed']);
  });

  it('a repo or group with live sessions: 409 naming them, then ?force=1', async () => {
    saveHistory([{ target: 'api', branch: 'feat/x', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '' }]);
    const res = await send('DELETE', '/api/repos/api');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { sessions: string[] }).sessions).toEqual(['api · feat/x']);
    expect((await send('DELETE', '/api/repos/api?force=1')).status).toBe(200);
  });

  it('groups: make one, change it, delete it; a bad body is 400', async () => {
    await send('POST', '/api/repos', { alias: 'web', path: path.join(src, 'web') });
    expect((await send('POST', '/api/groups', { name: 'shop', members: ['api', 'web'], creating: true })).status).toBe(200);
    expect((await inventory()).groups).toMatchObject([{ name: 'shop', members: ['api', 'web'], problem: null }]);
    expect((await send('POST', '/api/groups', { name: 'shop', members: ['api'], creating: false })).status).toBe(400);
    expect((await send('POST', '/api/groups', { name: 'shop' })).status).toBe(400);
    expect((await send('DELETE', '/api/groups/shop')).status).toBe(200);
    expect(loadConfig()!.groups).toEqual({});
  });
});
