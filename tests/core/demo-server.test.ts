import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startDemoServer } from '../../src/core/demo/demo-server.js';
import { DemoScenario } from '../../src/core/demo/scenario.js';
import type { SessionWire, ShipPreflight } from '../../src/core/api-types.js';

/**
 * The demo server behaves like work web over HTTP/WS — with no repos,
 * processes or ~/.work behind it. A controllable clock drives the scripted
 * timeline and simulated turns.
 */

let clock: number;
let scenario: DemoScenario;
let server: Awaited<ReturnType<typeof startDemoServer>>;
let webRoot: string;

beforeEach(async () => {
  clock = Date.parse('2026-09-29T09:00:00Z');
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>work</title><div id="root"></div>');
  scenario = new DemoScenario({ now: () => clock });
  server = await startDemoServer({ webRoot, scenario });
});
afterEach(async () => {
  await server.stop();
  fs.rmSync(webRoot, { recursive: true, force: true });
});

const get = async <T = any>(p: string): Promise<T> => (await fetch(server.url + p.replace(/^\//, ''))).json() as Promise<T>;
const send = (method: string, p: string, body?: unknown) =>
  fetch(server.url + p.replace(/^\//, ''), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const advance = (ms: number) => {
  clock += ms;
  scenario.tick();
};
const sessions = async () => (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions;
const byBranch = async (b: string) => (await sessions()).find((s) => s.branch === b)!;

describe('demo server', () => {
  it('serves the dashboard context and a realistic session list', async () => {
    expect(await get('/api/context')).toMatchObject({ mode: 'dashboard', demo: true });
    const list = await sessions();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.find((s) => s.branch === 'feat/invoice-export')?.attention).toMatchObject({ state: 'needs_input', seen: false });
    expect(list.find((s) => s.branch === 'fix/login-redirect')?.diffStat).toMatchObject({ files: 2 });
    expect(list.find((s) => s.target === 'shop')?.isGroup).toBe(true);
  });

  it('serves the SPA shell for dashboard routes', async () => {
    const res = await fetch(server.url + 's/abc/diff');
    expect(await res.text()).toContain('<div id="root">');
  });

  it('diffs parse into files for both scopes', async () => {
    const login = await byBranch('fix/login-redirect');
    const d = await get(`/api/sessions/${login.id}/diff?base=uncommitted`);
    expect(d.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    const shop = await byBranch('feat/checkout-v2');
    const b = await get(`/api/sessions/${shop.id}/diff?base=branch`);
    expect(b.repos.map((r: { name: string }) => r.name)).toEqual(['backend', 'frontend']);
  });

  it('shows failing CI, and asking Claude to fix it turns the checks green', async () => {
    const deps = await byBranch('chore/deps-update');
    const ci = await get(`/api/sessions/${deps.id}/ci`);
    expect(ci.repos[0].pr).toMatchObject({ number: 212, checks: 'fail', failing: [{ name: 'test (node 22)' }, { name: 'typecheck' }] });
    expect((await send('POST', `/api/sessions/${deps.id}/ci/fix`)).status).toBe(200);
    expect((await get(`/api/sessions/${deps.id}/comments`)).comments[0].body).toContain('CI is failing');
    advance(3_500);
    expect((await get(`/api/sessions/${deps.id}/ci`)).repos[0].pr.checks).toBe('pending');
    advance(4_000);
    expect((await get(`/api/sessions/${deps.id}/ci`)).repos[0].pr.checks).toBe('pass');
    expect((await send('POST', `/api/sessions/${deps.id}/ci/fix`)).status).toBe(409);
  });

  it('simulates a dev server on each worktree port', async () => {
    const login = await byBranch('fix/login-redirect');
    expect(login.port).toBeGreaterThan(0);
    expect(await get(`/api/sessions/${login.id}/dev`)).toMatchObject({ port: login.port, listening: false, command: 'npm run dev', running: null });
    expect((await send('POST', `/api/sessions/${login.id}/dev/start`)).status).toBe(200);
    expect(await get(`/api/sessions/${login.id}/dev`)).toMatchObject({ listening: false, running: expect.any(Object) });
    advance(2_000);
    expect(await get(`/api/sessions/${login.id}/dev`)).toMatchObject({ listening: true, url: `http://localhost:${login.port}/` });
    expect(await (await fetch(server.url + `api/sessions/${login.id}/dev/log`)).text()).toContain('VITE ready');
    expect((await send('POST', `/api/sessions/${login.id}/dev/stop`)).status).toBe(200);
    expect(await get(`/api/sessions/${login.id}/dev`)).toMatchObject({ listening: false, running: null });
  });

  it('notifies only when nobody is looking at the session', async () => {
    const notes: unknown[] = [];
    scenario.subscribe((e) => e.event === 'notify' && notes.push(e.data));
    const search = await byBranch('feat/search-filters');
    // Looking right at it: the scripted permission prompt stays silent.
    await send('POST', '/api/presence', { clientId: 't', sessionId: search.id, visible: true, focused: true, canNotify: true });
    advance(21_000);
    expect(notes).toEqual([]);
    expect((await byBranch('feat/search-filters')).attention).toMatchObject({ state: 'needs_input' });

    // Looking elsewhere: a turn that finishes does notify.
    await send('POST', '/api/presence', { clientId: 't', sessionId: null, visible: true, focused: true, canNotify: true });
    const inv = await byBranch('feat/invoice-export');
    scenario.input(inv.id, '1');
    for (let i = 0; i < 20 && !notes.length; i++) advance(1_000);
    expect(notes).toEqual([expect.objectContaining({ sessionId: inv.id, kind: 'idle', title: expect.stringMatching(/^Finished — /) })]);
    expect((await send('POST', '/api/presence', {})).status).toBe(400);
  });

  it('fakes per-turn checkpoints, and a turn diffs to part of the change', async () => {
    const login = await byBranch('fix/login-redirect');
    const { entries } = await get(`/api/sessions/${login.id}/checkpoints`);
    expect(entries.map((e: { id: number }) => e.id)).toEqual([0, 1, 2]);
    const last = await get(`/api/sessions/${login.id}/diff?from=1&to=2`);
    expect(last.base).toBe('range');
    expect(last.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.test.ts']);
    const all = await get(`/api/sessions/${login.id}/diff?from=0&to=2`);
    expect(all.repos[0].files).toHaveLength(2);
  });

  it('reverts a hunk or a file in the simulated diff and tells Claude', async () => {
    const login = await byBranch('fix/login-redirect');
    const r = await send('POST', `/api/sessions/${login.id}/revert`, { repo: 'web', path: 'src/auth.test.ts' });
    expect(r.status).toBe(200);
    const d = await get(`/api/sessions/${login.id}/diff?base=uncommitted`);
    expect(d.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts']);
    expect((await byBranch('fix/login-redirect')).diffStat).toMatchObject({ files: 1 });
    const { comments } = await get(`/api/sessions/${login.id}/comments`);
    expect(comments.at(-1).body).toContain('`src/auth.test.ts`');

    const h = d.repos[0].files[0].hunks[0];
    const hunk = await send('POST', `/api/sessions/${login.id}/revert`, { repo: 'web', path: 'src/auth.ts', lines: { start: h.newStart, end: h.newStart } });
    expect(hunk.status).toBe(200);
    expect((await get(`/api/sessions/${login.id}/diff?base=uncommitted`)).repos[0].files).toEqual([]);
    expect((await send('POST', `/api/sessions/${login.id}/revert`, { repo: 'web', path: 'src/auth.ts' })).status).toBe(409);
  });

  it('the scripted day moves on: an agent asks for permission, another finishes', async () => {
    expect((await byBranch('feat/search-filters')).attention?.state).toBe('working');
    advance(21_000);
    expect((await byBranch('feat/search-filters')).attention).toMatchObject({ state: 'needs_input', seen: false });
    advance(25_000);
    expect((await byBranch('feat/checkout-v2')).attention).toMatchObject({ state: 'idle', seen: false });
  });

  it('a comment gets a simulated reply from Claude', async () => {
    const login = await byBranch('fix/login-redirect');
    const res = await send('POST', `/api/sessions/${login.id}/comments`, { repo: 'web', file: 'src/auth.ts', line: 5, side: 'right', body: 'Log this?' });
    const { comment } = await res.json();
    advance(4_500);
    const { comments } = await get(`/api/sessions/${login.id}/comments`);
    expect(comments.find((c: { parentId?: string; author: string }) => c.parentId === comment.id)?.author).toBe('claude');
  });

  it('answering a blocked agent in the terminal resumes it, then it finishes', async () => {
    const inv = await byBranch('feat/invoice-export');
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/sessions/${inv.id}/terminal`);
    const frames: Array<{ bin: boolean; text: string }> = [];
    ws.on('message', (d, bin) => frames.push({ bin, text: d.toString() }));
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(frames[0].text)).toMatchObject({ type: 'replay' });
    expect(JSON.parse(frames[0].text).data).toContain('Do you want to proceed?');

    ws.send(JSON.stringify({ type: 'input', data: '1\r' }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await byBranch('feat/invoice-export')).attention?.state).toBe('working');
    advance(8_500);
    expect((await byBranch('feat/invoice-export')).attention).toMatchObject({ state: 'idle', seen: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.filter((f) => f.bin).map((f) => f.text).join('')).toContain('Added GET /invoices.csv');
    ws.close();
  });

  it('ships a group in parts: PRs, checks go green, merge one, then the other archives it', async () => {
    const shop = await byBranch('feat/checkout-v2');
    const pre0 = await get<ShipPreflight>(`/api/sessions/${shop.id}/ship`);
    expect(pre0.repos.map((r) => r.name)).toEqual(['backend', 'frontend']);

    await send('POST', `/api/sessions/${shop.id}/ship`, { action: 'create-pr' });
    let pre = await get<ShipPreflight>(`/api/sessions/${shop.id}/ship`);
    expect(pre.repos.every((r) => r.pr?.state === 'OPEN')).toBe(true);
    expect(pre.repos[0].mergeBlockers).toContain('checks still running');

    advance(6_500);
    pre = await get<ShipPreflight>(`/api/sessions/${shop.id}/ship`);
    const backend = pre.repos.find((r) => r.name === 'backend')!;
    expect(backend.mergeBlockers).toEqual([]);

    const first = await (await send('POST', `/api/sessions/${shop.id}/ship`, {
      action: 'merge', repos: [{ name: 'backend', headSha: backend.pr!.headSha }],
    })).json();
    expect(first).toMatchObject({ archived: false, allDone: false });

    const stale = await (await send('POST', `/api/sessions/${shop.id}/ship`, {
      action: 'merge', repos: [{ name: 'frontend', headSha: 'deadbeefdead' }],
    })).json();
    expect(stale.results[0].message).toMatch(/changed since you looked/);

    const frontend = (await get<ShipPreflight>(`/api/sessions/${shop.id}/ship`)).repos.find((r) => r.name === 'frontend')!;
    expect(frontend.mergeBlockers).toEqual([]);
    const last = await (await send('POST', `/api/sessions/${shop.id}/ship`, {
      action: 'merge', repos: [{ name: 'frontend', headSha: frontend.pr!.headSha }],
    })).json();
    expect(last).toMatchObject({ archived: true, allDone: true });
    expect((await byBranch('feat/checkout-v2')).archivedAt).toBeTruthy();
  });

  it('seen, archive, tasks and worktree create/delete', async () => {
    const login = await byBranch('fix/login-redirect');
    await send('POST', `/api/sessions/${login.id}/seen`);
    expect((await byBranch('fix/login-redirect')).attention?.seen).toBe(true);
    await send('POST', `/api/sessions/${login.id}/archive`, { archived: true });
    expect((await byBranch('fix/login-redirect')).archivedAt).toBeTruthy();

    const { tasks } = await (await send('POST', '/api/tasks', { text: 'Try the demo' })).json();
    expect(tasks.some((t: { text: string }) => t.text === 'Try the demo')).toBe(true);

    const created = await (await send('POST', '/api/worktrees', { target: 'shop', branch: 'feat/gift-cards' })).json();
    expect((await byBranch('feat/gift-cards')).isGroup).toBe(true);
    expect((await send('DELETE', `/api/sessions/${created.sessionId}/worktree`, {})).status).toBe(200);
    expect(await byBranch('feat/gift-cards')).toBeUndefined();

    expect((await send('POST', `/api/sessions/${login.id}/open-terminal`)).status).toBe(501);
  });

  it('keeps the same Origin guard as the real server', async () => {
    const res = await fetch(server.url + 'api/tasks', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{"text":"x"}',
    });
    expect(res.status).toBe(403);
  });
});
