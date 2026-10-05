import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const disposePty = vi.fn(async (_id: string) => {});
vi.mock('../../../src/core/pty/pty-pool.js', () => ({ disposePty: (id: string) => disposePty(id) }));

import { mountShipRoutes } from '../../../src/server/routes/ship-routes.js';
import { findSession, loadHistory, saveHistory, upsertSession, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';
import { rememberSent, saveDraft } from '../../../src/core/pr/pr-replies.js';

const SHA = 'abcdef123456';
let home: string;
let session: WorktreeSession;
let events: string[];
let changed: string[];
let merged: string[];

/** Per repo dir: 'ready' (open green PR at SHA), 'merged', 'untouched'. */
let repoState: Record<string, 'ready' | 'merged' | 'untouched'>;
let mergeFails = false;

const run: CommandRunner = async (cmd, args, cwd) => {
  const a = args.join(' ');
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const state = repoState[cwd] ?? 'ready';
  if (cmd === 'git') {
    if (a === 'rev-parse --abbrev-ref HEAD') return ok('feat/x\n');
    if (a === 'rev-parse HEAD') return ok(SHA + '\n');
    if (a.startsWith('rev-parse --verify')) return state === 'untouched' ? { code: 1, stdout: '', stderr: '' } : ok('x');
    if (a.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) return ok('origin/feat/x\n');
    if (a.startsWith('rev-list --left-right')) return ok('0 0\n');
    if (a === 'rev-parse --abbrev-ref origin/HEAD') return ok('origin/main\n');
    if (a.startsWith('rev-list --count')) return ok(state === 'untouched' ? '0\n' : '2\n');
    return ok();
  }
  if (args[1] === 'view') {
    if (state === 'untouched') return { code: 1, stdout: '', stderr: 'no pull requests found' };
    return ok(
      JSON.stringify({
        number: 5,
        url: 'u',
        state: state === 'merged' ? 'MERGED' : 'OPEN',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        headRefOid: SHA,
        statusCheckRollup: [],
      }),
    );
  }
  if (args[1] === 'merge') {
    if (mergeFails) return { code: 1, stdout: '', stderr: 'Head branch was modified' };
    merged.push(cwd);
    return ok();
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

function useSession(s: WorktreeSession) {
  session = s;
  for (const p of s.paths) fs.mkdirSync(p, { recursive: true });
  saveHistory([s]);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  useSession({ target: 'api', branch: 'feat/x', isGroup: false, paths: [path.join(home, 'wt')], createdAt: 'x', lastAccessedAt: 'x' });
  repoState = {};
  events = [];
  changed = [];
  merged = [];
  mergeFails = false;
  disposePty.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const archivedAt = () => loadHistory()[0].archivedAt;

describe('ship routes', () => {
  it('GET returns the preflight', async () => {
    const body = await (await app().request(`/api/sessions/${sessionIdFor(session)}/ship`)).json();
    expect(body.repos[0]).toMatchObject({ name: 'api', pr: { number: 5, headSha: SHA }, mergeBlockers: [], done: false });
  });

  it('merge requires the reviewed repos + SHAs', async () => {
    const id = sessionIdFor(session);
    for (const repos of [
      undefined,
      [],
      [{ name: 'api' }],
      [{ name: 'api', headSha: 'not-a-sha!' }],
      [
        { name: 'api', headSha: SHA },
        { name: 'api', headSha: SHA },
      ],
    ]) {
      expect((await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos })).status).toBe(400);
    }
    expect(merged).toEqual([]);
  });

  it('a successful merge that leaves every repo done archives the session and stops its Claude', async () => {
    const id = sessionIdFor(session);
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos: [{ name: 'api', headSha: SHA }] });
    expect(await res.json()).toMatchObject({ archived: true, allDone: true, results: [{ ok: true, merged: true }] });
    expect(disposePty).toHaveBeenCalledWith(id);
    expect(archivedAt()).toBeTruthy();
    expect(changed).toEqual([id]);
  });

  it('a partial group merge does NOT archive — the rest of the group is still open', async () => {
    const wt = path.join(home, 'shop');
    useSession({
      target: 'shop',
      branch: 'feat/x',
      isGroup: true,
      paths: [path.join(wt, 'backend'), path.join(wt, 'frontend')],
      createdAt: 'x',
      lastAccessedAt: 'x',
    });
    const id = sessionIdFor(session);
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos: [{ name: 'backend', headSha: SHA }] });
    expect(await res.json()).toMatchObject({ archived: false, allDone: false });
    expect(merged).toEqual([path.join(wt, 'backend')]);
    expect(archivedAt()).toBeUndefined();
    expect(disposePty).not.toHaveBeenCalled();
  });

  it('merging the last open repo of a partly merged group archives it', async () => {
    const wt = path.join(home, 'shop');
    useSession({
      target: 'shop',
      branch: 'feat/x',
      isGroup: true,
      paths: [path.join(wt, 'backend'), path.join(wt, 'frontend')],
      createdAt: 'x',
      lastAccessedAt: 'x',
    });
    repoState[path.join(wt, 'backend')] = 'merged';
    const id = sessionIdFor(session);
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos: [{ name: 'frontend', headSha: SHA }] });
    expect(await res.json()).toMatchObject({ archived: true, allDone: true });
  });

  it('a "merge" that merged nothing never archives (reviewed bug)', async () => {
    repoState[session.paths[0]] = 'untouched';
    const id = sessionIdFor(session);
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos: [{ name: 'api', headSha: SHA }] });
    expect(await res.json()).toMatchObject({ archived: false });
    expect(archivedAt()).toBeUndefined();
    expect(disposePty).not.toHaveBeenCalled();
  });

  it('a failed merge leaves it alone', async () => {
    mergeFails = true;
    const res = await post(app(), `/api/sessions/${sessionIdFor(session)}/ship`, {
      action: 'merge',
      repos: [{ name: 'api', headSha: SHA }],
    });
    expect(await res.json()).toMatchObject({ archived: false, results: [{ ok: false, message: 'Head branch was modified' }] });
    expect(archivedAt()).toBeUndefined();
  });

  it('validates action and method; unknown session is 404', async () => {
    const id = sessionIdFor(session);
    expect((await post(app(), `/api/sessions/${id}/ship`, { action: 'deploy' })).status).toBe(400);
    expect(
      (await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', method: 'octopus', repos: [{ name: 'api', headSha: SHA }] }))
        .status,
    ).toBe(400);
    expect((await post(app(), '/api/sessions/nope/ship', { action: 'push' })).status).toBe(404);
  });

  it('archive / unarchive; re-entering with work tree un-archives', async () => {
    const id = sessionIdFor(session);
    expect((await post(app(), `/api/sessions/${id}/archive`, { archived: true })).status).toBe(200);
    expect(archivedAt()).toBeTruthy();
    expect(disposePty).toHaveBeenCalledWith(id);
    await post(app(), `/api/sessions/${id}/archive`, { archived: false });
    expect(archivedAt()).toBeUndefined();
    await post(app(), `/api/sessions/${id}/archive`, { archived: true });
    await upsertSession('api', false, 'feat/x', session.paths);
    expect(archivedAt()).toBeUndefined();
    expect((await post(app(), `/api/sessions/${id}/archive`, {})).status).toBe(400);
    expect((await post(app(), '/api/sessions/nope/archive', { archived: true })).status).toBe(404);
  });

  it('archive refuses with what is still waiting (409), and goes ahead with force', async () => {
    const id = sessionIdFor(session);
    rememberSent(id, [{ threadId: 'PRRT_abcdef', repo: 'api', prNumber: 5, url: 'u', where: null, reviewer: 'r', excerpt: 'e' }]);
    saveDraft(id, 'PRRT_abcdef', 'Fixed in abc');
    const res = await post(app(), `/api/sessions/${id}/archive`, { archived: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ blocked: ['1 reply to post on review threads'] });
    expect(archivedAt()).toBeUndefined();
    expect(disposePty).not.toHaveBeenCalled();
    expect((await post(app(), `/api/sessions/${id}/archive`, { archived: true, force: true })).status).toBe(200);
    expect(archivedAt()).toBeTruthy();
  });

  it('Ship’s merge archives even with a reply draft waiting — the merge decides it, and the draft is kept', async () => {
    const id = sessionIdFor(session);
    rememberSent(id, [{ threadId: 'PRRT_abcdef', repo: 'api', prNumber: 5, url: 'u', where: null, reviewer: 'r', excerpt: 'e' }]);
    saveDraft(id, 'PRRT_abcdef', 'Fixed in abc');
    const res = await post(app(), `/api/sessions/${id}/ship`, { action: 'merge', repos: [{ name: 'api', headSha: SHA }] });
    expect(await res.json()).toMatchObject({ archived: true, allDone: true });
    expect(archivedAt()).toBeTruthy();
    const { listReplies } = await import('../../../src/core/pr/pr-replies.js');
    expect(listReplies(id).find((r) => r.threadId === 'PRRT_abcdef')).toMatchObject({ status: 'draft', draft: 'Fixed in abc' });
  });

  it('names a session, and an empty name goes back to the automatic one', async () => {
    const id = sessionIdFor(session);
    expect((await post(app(), `/api/sessions/${id}/title`, { title: '  Key rotation ' })).status).toBe(200);
    expect(findSession(loadHistory(), 'api', 'feat/x')?.title).toBe('Key rotation');
    await post(app(), `/api/sessions/${id}/title`, { title: '' });
    expect(findSession(loadHistory(), 'api', 'feat/x')?.title).toBeUndefined();
    expect((await post(app(), `/api/sessions/${id}/title`, { title: 3 })).status).toBe(400);
  });
});
