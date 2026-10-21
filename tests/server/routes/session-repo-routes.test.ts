import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { git } from '../../../src/core/git/git.js';
import { findSession, loadHistory } from '../../../src/core/sessions/history.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import {
  addRepoChildArgs,
  addRepoInChild,
  mountSessionRepoRoutes,
  parseChildOutcome,
  type AddRepoOutcome,
  type SessionRepoRouteOptions,
} from '../../../src/server/routes/session-repo-routes.js';
import { saveConfig } from '../../../src/core/platform/config.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

/** POST /api/sessions/:id/repos, with the child process, the scope and the comment route faked. */

let tmp: string;
let folder: string;
const now = new Date().toISOString();
let group: WorktreeSession;
let single: WorktreeSession;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-routes-')));
  folder = path.join(tmp, 'wt', 'shop', 'feat-x');
  group = {
    target: 'shop',
    branch: 'feat/x',
    isGroup: true,
    paths: [path.join(folder, 'api-repo')],
    repos: ['api'],
    createdAt: now,
    lastAccessedAt: now,
  };
  single = {
    target: 'api',
    branch: 'feat/old',
    isGroup: false,
    paths: [path.join(tmp, 'wt', 'api-repo', 'feat-old')],
    createdAt: now,
    lastAccessedAt: now,
  };
  saveConfig({
    worktreesRoot: path.join(tmp, 'wt'),
    repos: { api: path.join(tmp, 'src', 'api-repo'), web: path.join(tmp, 'src', 'web-repo'), apicopy: path.join(tmp, 'x', 'api-repo') },
    groups: { shop: ['api'] },
    copyFiles: [],
  });
  saveHistory([group, single]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const wire = () => ({ ok: true as const, path: path.join(folder, 'web-repo'), branch: 'feat/x', created: true, from: 'main' });

function app(over: Partial<SessionRepoRouteOptions> = {}) {
  const events: string[] = [];
  const calls: string[] = [];
  const opts: SessionRepoRouteOptions = {
    broadcast: (e) => void events.push(e),
    run: vi.fn(async (): Promise<AddRepoOutcome> => (calls.push('run'), { ok: true, wire: wire() })),
    release: vi.fn(() => void calls.push('release')),
    invalidate: vi.fn(),
    note: vi.fn(async () => {}),
    ...over,
  };
  const a = new Hono();
  mountSessionRepoRoutes(a, opts);
  return { a, opts, events, calls };
}
const post = (a: Hono, id: string, body: unknown) =>
  a.request(`/api/sessions/${id}/repos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/sessions/:id/repos', () => {
  it('releases the scope, runs the add, tells Claude and the dashboard, and answers what it did', async () => {
    const { a, opts, events, calls } = app();
    const id = sessionIdFor(group);
    const res = await post(a, id, { alias: 'web', base: ' dev ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(wire());
    expect(calls).toEqual(['release', 'run']); // the scope let go of before the paths change
    expect(opts.release).toHaveBeenCalledWith(id, group.paths);
    expect(opts.run).toHaveBeenCalledWith(id, 'web', 'dev');
    expect(opts.invalidate).toHaveBeenCalledWith(id);
    expect(opts.note).toHaveBeenCalledWith(
      id,
      "Added repo web to this session: ./web-repo on branch feat/x, made from main. Its CLAUDE.md is imported by the session's instructions file.",
    );
    expect(events).toContain('sessions-changed');
  });

  it.each([
    ['an unknown session', (): string => 'nope', { alias: 'web' }, 404, /unknown session/],
    [
      'an archived session',
      (): string => (saveHistory([{ ...group, archivedAt: now }, single]), sessionIdFor(group)),
      { alias: 'web' },
      409,
      /archived/,
    ],
    ['a single repo in the old layout', (): string => sessionIdFor(single), { alias: 'web' }, 409, /sessionFolders: true/],
    ['an unknown alias', (): string => sessionIdFor(group), { alias: 'nope' }, 400, /no repo called nope/],
    ['a repo already in the session', (): string => sessionIdFor(group), { alias: 'api' }, 409, /already/],
    ['a folder name the session has', (): string => sessionIdFor(group), { alias: 'apicopy' }, 409, /folder called api-repo/],
    ['an alias starting with "-"', (): string => sessionIdFor(group), { alias: '--x' }, 400, /not a valid/],
    ['a base starting with "-"', (): string => sessionIdFor(group), { alias: 'web', base: '-b' }, 400, /not a valid/],
  ] as const)('refuses %s, running and releasing nothing', async (_label, idOf, body, status, message) => {
    const { a, opts, events } = app();
    const res = await post(a, idOf(), body);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(opts.run).not.toHaveBeenCalled();
    expect(opts.release).not.toHaveBeenCalled();
    expect(opts.note).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a missing alias is a bad request', async () => {
    const { a, opts } = app();
    expect((await post(a, sessionIdFor(group), {})).status).toBe(400);
    expect(opts.run).not.toHaveBeenCalled();
  });

  it("a failure in the child is answered with its reason, and Claude isn't told", async () => {
    const { a, opts, events } = app({ run: vi.fn(async () => ({ ok: false as const, error: "Base branch 'nope' does not exist" })) });
    const res = await post(a, sessionIdFor(group), { alias: 'web', base: 'nope' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Base branch 'nope' does not exist" });
    expect(opts.note).not.toHaveBeenCalled();
    expect(events).toContain('sessions-changed');
  });

  it('a note that fails to post leaves the add done', async () => {
    const { a } = app({ note: vi.fn(async () => Promise.reject(new Error('down'))) });
    expect((await post(a, sessionIdFor(group), { alias: 'web' })).status).toBe(200);
  });

  it('one add per session at a time', async () => {
    let finish: (r: AddRepoOutcome) => void = () => {};
    const run = vi.fn(() => new Promise<AddRepoOutcome>((resolve) => (finish = resolve)));
    const { a } = app({ run });
    const id = sessionIdFor(group);
    const first = post(a, id, { alias: 'web' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const second = await post(a, id, { alias: 'web' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/being added/);
    finish({ ok: true, wire: wire() });
    expect((await first).status).toBe(200);
    // Done: the next one runs.
    run.mockImplementationOnce(async () => ({ ok: false, error: 'again' }));
    expect((await post(a, id, { alias: 'web' })).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('the child', () => {
  it('its arguments: values as --flag=value', () => {
    expect(addRepoChildArgs('abc', 'web', undefined)).toEqual(['add-repo', 'web', '--session-id=abc', '--in-process', '--json']);
    expect(addRepoChildArgs('abc', 'web', 'dev')).toContain('--base=dev');
  });

  it('its answer: the last JSON line, an error line, else stderr', () => {
    const ok = JSON.stringify(wire());
    expect(parseChildOutcome(`noise\n${ok}\n`, '', 0)).toEqual({ ok: true, wire: wire() });
    expect(parseChildOutcome('{"error":"no repo called x in your config"}\n', 'warn line', 1)).toEqual({
      ok: false,
      error: 'no repo called x in your config',
    });
    expect(parseChildOutcome('', '\x1b[31mboom\x1b[0m\n  more\n', 1)).toEqual({ ok: false, error: 'boom more' });
    expect(parseChildOutcome('', '', null)).toEqual({ ok: false, error: 'work add-repo exited (killed)' });
  });
});

describe('a real child (`work add-repo --in-process --json`, under tsx)', () => {
  const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'bin.ts');

  it('checks the repo out off the event loop and answers what it did; a failure says why', async () => {
    const repos: Record<string, string> = {};
    for (const name of ['api', 'web']) {
      const dir = path.join(tmp, 'real', `${name}-repo`);
      fs.mkdirSync(dir, { recursive: true });
      git(['init', '-b', 'main'], dir);
      git(['config', 'user.email', 't@t.t'], dir);
      git(['config', 'user.name', 'T'], dir);
      fs.writeFileSync(path.join(dir, 'r.txt'), name);
      git(['add', '.'], dir);
      git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
      repos[name] = dir;
    }
    const config = { worktreesRoot: path.join(tmp, 'real', 'wt'), repos, groups: {}, copyFiles: [], sessionFolders: true };
    saveConfig(config);
    expect(await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false })).toBeTruthy();
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    const { a, opts } = app({ run: addRepoInChild(() => BIN, { execArgv: ['--import', 'tsx'], timeoutMs: 120_000 }) });

    // A base that doesn't exist: the child's own reason, nothing recorded.
    const bad = await post(a, id, { alias: 'web', base: 'nope' });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toMatch(/nope/);
    expect(findSession(loadHistory(), 'api', 'feat/x')?.repos).toEqual(['api']);

    let ticks = 0;
    const tick = setInterval(() => ticks++, 20);
    const res = await post(a, id, { alias: 'web' });
    clearInterval(tick);
    expect(res.status).toBe(200);
    const folder = path.join(config.worktreesRoot, 'api', 'feat-x');
    expect(await res.json()).toEqual({ ok: true, path: path.join(folder, 'web-repo'), branch: 'feat/x', created: true, from: 'main' });
    expect(findSession(loadHistory(), 'api', 'feat/x')?.repos).toEqual(['api', 'web']);
    expect(opts.note).toHaveBeenCalledWith(id, expect.stringContaining('Added repo web'));
    expect(ticks).toBeGreaterThan(5); // nothing here waited on git
  }, 240_000);
});
