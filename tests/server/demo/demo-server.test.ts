import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startDemoServer } from '../../../src/server/demo/demo-server.js';
import { DemoScenario } from '../../../src/server/demo/scenario.js';
import type { SessionCi, SessionWire, ShipPreflight } from '../../../src/core/api-types.js';
import type { CheckpointEntry } from '../../../src/core/diff/checkpoint.js';
import type { Comment } from '../../../src/core/comments/comment-types.js';

/** What a session's diff route answers (the fields these tests read). */
type DiffWire = {
  base?: string;
  repos: Array<{ name: string; files: Array<{ path: string; hunks: Array<{ newStart: number; newLines: number }> }> }>;
};
type Comments = { comments: Comment[] };

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

const get = async <T = unknown>(p: string): Promise<T> => (await fetch(server.url + p.replace(/^\//, ''))).json() as Promise<T>;
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

  it('drives a session like work web: send queues a published note, start / stop / screen answer in the same shapes', async () => {
    const s = await byBranch('fix/login-redirect');
    const sent = await send('POST', `/api/sessions/${s.id}/send`, { text: 'Run the tests' });
    expect(await sent.json()).toMatchObject({ how: 'typed', sentAt: new Date(clock).toISOString() });
    const comments = (await get<{ comments: Array<{ body: string; status: string }> }>(`/api/sessions/${s.id}/comments`)).comments;
    expect(comments.find((c) => c.body === 'Run the tests')).toMatchObject({ status: 'published' });
    expect((await send('POST', `/api/sessions/${s.id}/send`, { text: '  ' })).status).toBe(400);
    expect(await (await send('POST', `/api/sessions/${s.id}/agent/start`, {})).json()).toEqual({ how: 'running' });
    expect(await (await send('POST', `/api/sessions/${s.id}/agent/stop`, {})).json()).toEqual({ how: 'stopped' });
    expect(typeof (await get<{ text: string }>(`/api/sessions/${s.id}/screen`)).text).toBe('string');
    expect((await send('POST', '/api/sessions/nope/send', { text: 'x' })).status).toBe(404);
  });

  it('serves the SPA shell for dashboard routes', async () => {
    const res = await fetch(server.url + 's/abc/diff');
    expect(await res.text()).toContain('<div id="root">');
  });

  it('diffs parse into files for both scopes', async () => {
    const login = await byBranch('fix/login-redirect');
    const d = await get<DiffWire>(`/api/sessions/${login.id}/diff?base=uncommitted`);
    expect(d.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    const shop = await byBranch('feat/checkout-v2');
    const b = await get<DiffWire>(`/api/sessions/${shop.id}/diff?base=branch`);
    expect(b.repos.map((r: { name: string }) => r.name)).toEqual(['backend', 'frontend']);
  });

  it('shows failing CI, and asking Claude to fix it turns the checks green', async () => {
    const deps = await byBranch('chore/deps-update');
    const ci = await get<SessionCi>(`/api/sessions/${deps.id}/ci`);
    expect(ci.repos[0].pr).toMatchObject({ number: 212, checks: 'fail', failing: [{ name: 'test (node 22)' }, { name: 'typecheck' }] });
    expect((await send('POST', `/api/sessions/${deps.id}/ci/fix`)).status).toBe(200);
    expect((await get<Comments>(`/api/sessions/${deps.id}/comments`)).comments[0].body).toContain('CI is failing');
    advance(3_500);
    expect((await get<SessionCi>(`/api/sessions/${deps.id}/ci`)).repos[0].pr?.checks).toBe('pending');
    advance(4_000);
    expect((await get<SessionCi>(`/api/sessions/${deps.id}/ci`)).repos[0].pr?.checks).toBe('pass');
    expect((await send('POST', `/api/sessions/${deps.id}/ci/fix`)).status).toBe(409);
  });

  it('simulates a dev server on each worktree port', async () => {
    const login = await byBranch('fix/login-redirect');
    expect(login.port).toBeGreaterThan(0);
    expect(await get(`/api/sessions/${login.id}/dev`)).toMatchObject({
      port: login.port,
      listening: false,
      command: 'npm run dev',
      running: null,
    });
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
    const { entries } = await get<{ entries: CheckpointEntry[] }>(`/api/sessions/${login.id}/checkpoints`);
    expect(entries.map((e: { id: number }) => e.id)).toEqual([0, 1, 2]);
    const last = await get<DiffWire>(`/api/sessions/${login.id}/diff?from=1&to=2`);
    expect(last.base).toBe('range');
    expect(last.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.test.ts']);
    const all = await get<DiffWire>(`/api/sessions/${login.id}/diff?from=0&to=2`);
    expect(all.repos[0].files).toHaveLength(2);
  });

  it('reverts a hunk or a file in the simulated diff and tells Claude', async () => {
    const login = await byBranch('fix/login-redirect');
    const r = await send('POST', `/api/sessions/${login.id}/revert`, { repo: 'web', path: 'src/auth.test.ts' });
    expect(r.status).toBe(200);
    const d = await get<DiffWire>(`/api/sessions/${login.id}/diff?base=uncommitted`);
    expect(d.repos[0].files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts']);
    expect((await byBranch('fix/login-redirect')).diffStat).toMatchObject({ files: 1 });
    const { comments } = await get<Comments>(`/api/sessions/${login.id}/comments`);
    expect(comments.at(-1)!.body).toContain('`src/auth.test.ts`');

    const h = d.repos[0].files[0].hunks[0];
    const hunk = await send('POST', `/api/sessions/${login.id}/revert`, {
      repo: 'web',
      path: 'src/auth.ts',
      lines: { start: h.newStart, end: h.newStart },
    });
    expect(hunk.status).toBe(200);
    expect((await get<DiffWire>(`/api/sessions/${login.id}/diff?base=uncommitted`)).repos[0].files).toEqual([]);
    expect((await send('POST', `/api/sessions/${login.id}/revert`, { repo: 'web', path: 'src/auth.ts' })).status).toBe(409);
  });

  it('shows a stack, by the real rule: the seeded fork, and a new fork of any session', async () => {
    const list = async () => (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions;
    const byBranch = async (b: string) => (await list()).find((s) => s.branch === b)!;
    const parent = await byBranch('feat/invoice-export');
    expect(await byBranch('feat/invoice-pdf')).toMatchObject({
      stackedOn: { id: parent.id, branch: 'feat/invoice-export' },
      behind: { base: 'feat/invoice-export', stacked: true },
    });
    expect(parent.stackedChildren).toBe(1);
    const login = (await list()).find((s) => s.branch !== 'feat/invoice-export' && !s.archivedAt && !s.stackedOn)!;
    expect((await send('POST', `/api/sessions/${login.id}/fork`, { branch: `${login.branch}-2` })).status).toBe(200);
    expect((await byBranch(`${login.branch}-2`)).stackedOn).toMatchObject({ id: login.id });
  });

  it('shows a session whose parent merged, and Move onto main takes it off the stack', async () => {
    const list = async () => (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions;
    const report = (await list()).find((s) => s.branch === 'feat/tax-report')!;
    expect(report.stackParentMerged).toMatchObject({ branch: 'feat/tax-rates' });
    expect((await send('POST', `/api/sessions/${report.id}/retarget`)).status).toBe(200);
    expect((await list()).find((s) => s.branch === 'feat/tax-report')!.stackParentMerged).toBeUndefined();
    expect((await send('POST', `/api/sessions/${report.id}/retarget`)).status).toBe(409);
  });

  it('snoozes until a time too', async () => {
    const s = (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions[0];
    const until = new Date(clock + 3 * 3600_000).toISOString();
    expect((await send('POST', `/api/sessions/${s.id}/snooze`, { until })).status).toBe(200);
    expect((await send('POST', `/api/sessions/${s.id}/snooze`, { until: 'nope' })).status).toBe(400);
  });

  it('a session waiting on another leaves the Inbox ranks (blockedBy on the row); stopping clears it', async () => {
    const [one, two] = (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions;
    expect((await send('POST', `/api/sessions/${one.id}/blocks`, { kind: 'session', id: two.id })).status).toBe(200);
    expect((await send('POST', `/api/sessions/${one.id}/blocks`, { kind: 'pr', url: 'nope' })).status).toBe(400);
    const row = (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions.find((s) => s.id === one.id)!;
    expect(row.blockedBy).toEqual([expect.objectContaining({ kind: 'session', sessionId: two.id })]);
    await send('DELETE', `/api/sessions/${one.id}/blocks`);
    expect((await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions.find((s) => s.id === one.id)!.blockedBy).toBeUndefined();
  });

  it('a timeline for a session, by the real builder', async () => {
    const s = (await get<{ sessions: SessionWire[] }>('/api/sessions')).sessions[0];
    const t = await get<{ events: Array<{ kind: string }> }>(`/api/sessions/${s.id}/timeline`);
    expect(t.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['created', 'commit']));
  });

  it('says whether a branch is new for a project, and the next free name when it is not', async () => {
    type Check = { exists: boolean; session: { id: string } | null; free: string | null; valid: boolean };
    const taken = await get<Check>('/api/branch-check?target=api&branch=feat/invoice-export');
    expect(taken).toMatchObject({ exists: true, valid: true, free: 'feat/invoice-export-2' });
    expect(taken.session).not.toBeNull();
    expect(await get<Check>('/api/branch-check?target=api&branch=feat/brand-new')).toMatchObject({
      exists: false,
      session: null,
      free: 'feat/brand-new',
    });
    expect(await get<Check>('/api/branch-check?target=api&branch=fix/')).toMatchObject({ valid: false, free: null });
  });

  it('remembers how far you looked at a diff, forward only, and serves the range up to the working tree', async () => {
    const id = (await byBranch('fix/login-redirect')).id;
    expect(await get<{ seen: unknown }>(`/api/sessions/${id}/diff-seen`)).toEqual({ seen: null });
    expect((await send('POST', `/api/sessions/${id}/diff-seen`, { checkpointId: 2 })).status).toBe(200);
    await send('POST', `/api/sessions/${id}/diff-seen`, { checkpointId: 1 });
    expect((await get<{ seen: { checkpointId: number } }>(`/api/sessions/${id}/diff-seen`)).seen.checkpointId).toBe(2);
    const d = await get<{ repos: unknown[] }>(`/api/sessions/${id}/diff?from=1&to=working`);
    expect(d.repos.length).toBeGreaterThan(0);
  });

  it('PR stages: an approved green PR wants you until seen at that stage; one waiting on reviewers is in review', async () => {
    type Row = { id: string; branch: string; prStage?: { kind: string; key: string; seen?: boolean; text: string } };
    const rows = (await get<{ sessions: Row[] }>('/api/sessions')).sessions;
    const ready = rows.find((r) => r.branch === 'feat/order-history')!;
    expect(ready.prStage).toMatchObject({ kind: 'ready', text: 'PR #209 · approved, ready to merge' });
    expect(rows.find((r) => r.branch === 'feat/tax-report')!.prStage).toMatchObject({ kind: 'in_review' });
    expect((await send('POST', `/api/sessions/${ready.id}/seen`, { prStage: ready.prStage })).status).toBe(200);
    const after = (await get<{ sessions: Row[] }>('/api/sessions')).sessions.find((r) => r.id === ready.id)!;
    expect(after.prStage?.seen).toBe(true);
  });

  it('first run: the demo is set up already, and its folders are pretend', async () => {
    expect(await get('/api/setup')).toMatchObject({
      configured: true,
      repos: 4,
      tools: expect.arrayContaining([expect.objectContaining({ id: 'claude', ok: true })]),
    });
    expect((await send('POST', '/api/setup', { worktreesRoot: '/x', reposFolder: '/y' })).status).toBe(400);
  });

  it('the Repos page: enrol a found repo, make a group of it, and undo both', async () => {
    type Inv = { repos: { folder: string; status: string; suggestedAlias?: string }[]; groups: { name: string; sessions: number }[] };
    const before = await get<Inv>('/api/repos');
    expect(before.repos.find((r) => r.folder === 'billing')).toMatchObject({ status: 'new', suggestedAlias: 'billing' });
    expect((await send('POST', '/api/repos', { alias: 'billing', path: '~/repos/billing' })).status).toBe(200);
    expect((await send('POST', '/api/repos', { alias: 'api', path: '~/repos/hangfire' })).status).toBe(400);
    expect((await send('POST', '/api/groups', { name: 'money', members: ['api', 'billing'], creating: true })).status).toBe(200);
    expect((await get<Inv>('/api/repos')).groups.map((g) => g.name)).toContain('money');
    expect((await send('POST', '/api/groups', { name: 'money', members: ['api'], creating: false })).status).toBe(400);
    expect((await send('DELETE', '/api/groups/money')).status).toBe(200);
    expect((await send('DELETE', '/api/repos/billing')).status).toBe(200);
    expect((await get<Inv>('/api/repos')).repos.find((r) => r.folder === 'billing')?.status).toBe('new');
    // A group with live sessions is refused, naming them, unless forced.
    const shop = before.groups.find((g) => g.name === 'shop')!;
    if (shop.sessions > 0) {
      const res = await send('DELETE', '/api/groups/shop');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { sessions: string[] }).sessions.length).toBeGreaterThan(0);
    }
    expect((await send('POST', '/api/repos/roots', { path: 'C:/x', on: true })).status).toBe(400);
  });

  it('keeps the sessions list order', async () => {
    expect(await get('/api/session-order')).toEqual({ order: [] });
    expect((await send('PUT', '/api/session-order', { order: ['b', 'a'] })).status).toBe(200);
    expect(await get('/api/session-order')).toEqual({ order: ['b', 'a'] });
    expect((await send('PUT', '/api/session-order', { order: 'nope' })).status).toBe(400);
  });

  it('Today shows the seeded day even when asked right after midnight', async () => {
    // "Since midnight", five minutes after it: the seeded prompts are older.
    const d = await get<{ sessions: Array<{ branch: string; prompts: Array<{ text: string }> }> }>(
      `/api/digest?since=${new Date(clock - 5 * 60_000).toISOString()}`,
    );
    const inv = d.sessions.find((x) => x.branch === 'feat/invoice-export');
    expect(inv?.prompts.map((p) => p.text)).toContain('Add CSV export to the invoices endpoint');
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
    const res = await send('POST', `/api/sessions/${login.id}/comments`, {
      repo: 'web',
      file: 'src/auth.ts',
      line: 5,
      side: 'right',
      body: 'Log this?',
    });
    const { comment } = await res.json();
    advance(4_500);
    const { comments } = await get<Comments>(`/api/sessions/${login.id}/comments`);
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
    expect(
      frames
        .filter((f) => f.bin)
        .map((f) => f.text)
        .join(''),
    ).toContain('Added GET /invoices.csv');
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

    const first = await (
      await send('POST', `/api/sessions/${shop.id}/ship`, {
        action: 'merge',
        repos: [{ name: 'backend', headSha: backend.pr!.headSha }],
      })
    ).json();
    expect(first).toMatchObject({ archived: false, allDone: false });

    const stale = await (
      await send('POST', `/api/sessions/${shop.id}/ship`, {
        action: 'merge',
        repos: [{ name: 'frontend', headSha: 'deadbeefdead' }],
      })
    ).json();
    expect(stale.results[0].message).toMatch(/changed since you looked/);

    const frontend = (await get<ShipPreflight>(`/api/sessions/${shop.id}/ship`)).repos.find((r) => r.name === 'frontend')!;
    expect(frontend.mergeBlockers).toEqual([]);
    const last = await (
      await send('POST', `/api/sessions/${shop.id}/ship`, {
        action: 'merge',
        repos: [{ name: 'frontend', headSha: frontend.pr!.headSha }],
      })
    ).json();
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
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{"text":"x"}',
    });
    expect(res.status).toBe(403);
  });
});
