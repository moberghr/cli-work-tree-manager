import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const disposePty = vi.fn(async (_id: string) => {});
vi.mock('../../src/core/pty-pool.js', () => ({ disposePty: (id: string) => disposePty(id) }));

import { mountShipRoutes } from '../../src/core/ship-routes.js';
import { loadHistory, saveHistory, upsertSession, type WorktreeSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/web-state.js';
import type { CommandRunner } from '../../src/core/ship.js';

let home: string;
let wt: string;
let session: WorktreeSession;
let events: string[];
let changed: string[];

// A clean, pushed branch with an open green PR; the merge succeeds unless
// mergeFails is set.
let mergeFails = false;
const run: CommandRunner = async (cmd, args) => {
  const a = args.join(' ');
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  if (cmd === 'git') {
    if (a === 'rev-parse --abbrev-ref HEAD') return ok('feat/x\n');
    if (a.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) return ok('origin/feat/x\n');
    if (a.startsWith('rev-list --left-right')) return ok('0 0\n');
    if (a === 'rev-parse --abbrev-ref origin/HEAD') return ok('origin/main\n');
    if (a.startsWith('rev-list --count')) return ok('2\n');
    return ok();
  }
  if (args[1] === 'view') {
    return ok(JSON.stringify({
      number: 5, url: 'u', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN',
      headRefOid: 'sha', statusCheckRollup: [],
    }));
  }
  if (args[1] === 'merge') {
    return mergeFails ? { code: 1, stdout: '', stderr: 'Head branch was modified' } : ok();
  }
  return ok();
};

function app() {
  const a = new Hono();
  mountShipRoutes(a, { broadcast: (e) => events.push(e), onRepoChanged: (id) => changed.push(id), run });
  return a;
}
const post = (a: Hono, url: string, body: unknown) =>
  a.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  session = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
  saveHistory([session]);
  events = [];
  changed = [];
  mergeFails = false;
  disposePty.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ship routes', () => {
  it('GET returns the preflight', async () => {
    const res = await app().request(`/api/sessions/${sessionIdFor(session)}/ship`);
    const body = await res.json();
    expect(body.repos[0]).toMatchObject({ name: 'api', pr: { number: 5 }, mergeBlockers: [] });
  });

  it('a successful merge archives the session and stops its Claude', async () => {
    const id = sessionIdFor(session);
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge' });
    expect(await res.json()).toMatchObject({ archived: true, results: [{ ok: true }] });
    expect(disposePty).toHaveBeenCalledWith(id);
    expect(loadHistory()[0].archivedAt).toBeTruthy();
    expect(changed).toEqual([id]);
    expect(events).toContain('sessions-changed');
  });

  it('a failed merge leaves it alone', async () => {
    mergeFails = true;
    const res = await post(app(), `/api/sessions/${sessionIdFor(session)}/ship`, { action: 'merge' });
    expect(await res.json()).toMatchObject({
      archived: false,
      results: [{ ok: false, message: 'Head branch was modified' }],
    });
    expect(loadHistory()[0].archivedAt).toBeUndefined();
    expect(disposePty).not.toHaveBeenCalled();
  });

  it('validates action and method', async () => {
    const id = sessionIdFor(session);
    expect((await post(app(), `/api/sessions/${id}/ship`, { action: 'deploy' })).status).toBe(400);
    expect((await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', method: 'octopus' })).status).toBe(400);
    expect((await post(app(), '/api/sessions/nope/ship', { action: 'merge' })).status).toBe(404);
  });

  it('archive / unarchive; re-entering with work tree un-archives', async () => {
    const id = sessionIdFor(session);
    expect((await post(app(), `/api/sessions/${id}/archive`, { archived: true })).status).toBe(200);
    expect(loadHistory()[0].archivedAt).toBeTruthy();
    expect(disposePty).toHaveBeenCalledWith(id);
    await post(app(), `/api/sessions/${id}/archive`, { archived: false });
    expect(loadHistory()[0].archivedAt).toBeUndefined();

    await post(app(), `/api/sessions/${id}/archive`, { archived: true });
    await upsertSession('api', false, 'feat/x', [wt]);
    expect(loadHistory()[0].archivedAt).toBeUndefined();

    expect((await post(app(), `/api/sessions/${id}/archive`, {})).status).toBe(400);
    expect((await post(app(), '/api/sessions/nope/archive', { archived: true })).status).toBe(404);
  });
});
