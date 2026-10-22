import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { git } from '../../../src/core/git/git.js';
import { findSession, loadHistory } from '../../../src/core/sessions/history.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { mountSessionRepoRoutes, scopeReleaser, type SessionRepoRouteOptions } from '../../../src/server/routes/session-repo-routes.js';
import { addRepoInChild, type AddRepoOutcome } from '../../../src/core/worktree/add-repo-child.js';
import { keyedQueue } from '../../../src/core/worktree/setup-child.js';
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

const wire = () => ({
  ok: true as const,
  path: path.join(folder, 'web-repo'),
  branch: 'feat/x',
  created: true,
  from: 'main',
  imported: true,
  warnings: [] as string[],
});

function app(over: Partial<SessionRepoRouteOptions> = {}) {
  const events: string[] = [];
  const calls: string[] = [];
  const opts: SessionRepoRouteOptions = {
    broadcast: (e) => void events.push(e),
    run: vi.fn(async (): Promise<AddRepoOutcome> => (calls.push('run'), { ok: true, wire: wire() })),
    queue: keyedQueue(),
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
    // The scope let go of before the paths change, and again after (a hook may have opened it meanwhile).
    expect(calls).toEqual(['release', 'run', 'release']);
    expect(opts.release).toHaveBeenNthCalledWith(1, id, group.paths);
    expect(opts.release).toHaveBeenNthCalledWith(2, id, group.paths);
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

  it("a failure in the child is answered with its reason and status, the scope let go of again, and Claude isn't told", async () => {
    const { a, opts, events, calls } = app({
      run: vi.fn(
        async (): Promise<AddRepoOutcome> => (calls.push('run'), { ok: false, error: "Base branch 'nope' does not exist", status: 500 }),
      ),
    });
    const id = sessionIdFor(group);
    const res = await post(a, id, { alias: 'web', base: 'nope' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Base branch 'nope' does not exist" });
    expect(calls).toEqual(['release', 'run', 'release']);
    expect(opts.invalidate).toHaveBeenCalledWith(id);
    expect(opts.note).not.toHaveBeenCalled();
    expect(events).toContain('sessions-changed');
  });

  it("a refusal the child found keeps the child's status", async () => {
    const { a } = app({ run: vi.fn(async (): Promise<AddRepoOutcome> => ({ ok: false, error: 'unknown session', status: 404 })) });
    expect((await post(a, sessionIdFor(group), { alias: 'web' })).status).toBe(404);
  });

  it('a note that fails to post leaves the add done, and says so in its warnings', async () => {
    const { a } = app({ note: vi.fn(async () => Promise.reject(new Error('down'))) });
    const res = await post(a, sessionIdFor(group), { alias: 'web' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings: string[] }).warnings).toEqual(["couldn't tell its Claude: down"]);
  });

  it("the child's warnings are in the answer", async () => {
    const { a } = app({
      run: vi.fn(async (): Promise<AddRepoOutcome> => ({ ok: true, wire: { ...wire(), warnings: ["the Diff tab's turns: x"] } })),
    });
    expect(((await (await post(a, sessionIdFor(group), { alias: 'web' })).json()) as { warnings: string[] }).warnings).toEqual([
      "the Diff tab's turns: x",
    ]);
  });

  it('runs the add only once the scope has been let go of', async () => {
    let released: () => void = () => {};
    const release = vi.fn(() => new Promise<void>((r) => (released = r)));
    const { a, opts } = app({ release });
    const pending = post(a, sessionIdFor(group), { alias: 'web' });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(opts.run).not.toHaveBeenCalled();
    released();
    await vi.waitFor(() => expect(opts.run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    released();
    expect((await pending).status).toBe(200);
  });

  it('a release that fails is answered cleanly, and the session is free again', async () => {
    const release = vi.fn(async (): Promise<void> => Promise.reject(new Error('watcher stuck')));
    const { a, opts } = app({ release });
    const id = sessionIdFor(group);
    const res = await post(a, id, { alias: 'web' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/watcher stuck/);
    expect(opts.run).not.toHaveBeenCalled();
    release.mockImplementation(async () => {});
    expect((await post(a, id, { alias: 'web' })).status).toBe(200);
  });

  it('a run that throws frees the session too', async () => {
    const run = vi.fn(async (): Promise<AddRepoOutcome> => Promise.reject(new Error('boom')));
    const { a } = app({ run });
    const id = sessionIdFor(group);
    expect((await post(a, id, { alias: 'web' })).status).toBe(500);
    run.mockImplementation(async () => ({ ok: true, wire: wire() }));
    expect((await post(a, id, { alias: 'web' })).status).toBe(200);
  });

  it('waits its turn behind a creation in the same repo, but not behind another repo', async () => {
    const queue = keyedQueue();
    let freeWeb: () => void = () => {};
    void queue('web', () => new Promise<void>((r) => (freeWeb = r)));
    const { a, opts } = app({ queue });
    const pending = post(a, sessionIdFor(group), { alias: 'web' });
    await new Promise((r) => setTimeout(r, 30));
    expect(opts.run).not.toHaveBeenCalled();
    // Another repo, another queue: a creation elsewhere doesn't hold it up.
    let other = false;
    await queue('docs', async () => {
      other = true;
    });
    expect(other).toBe(true);
    freeWeb();
    expect((await pending).status).toBe(200);
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
    run.mockImplementationOnce(async () => ({ ok: false, error: 'again', status: 409 }));
    expect((await post(a, id, { alias: 'web' })).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(2);
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
    expect(await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false })).toMatchObject({ isGroup: true });
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    const { a, opts } = app({ run: addRepoInChild(() => BIN, { execArgv: ['--import', 'tsx'], timeoutMs: 120_000 }) });

    // A base that doesn't exist: the child's own reason, nothing recorded.
    const bad = await post(a, id, { alias: 'web', base: 'nope' });
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { error: string }).error).toMatch(/nope/);
    expect(findSession(loadHistory(), 'api', 'feat/x')?.repos).toEqual(['api']);

    let ticks = 0;
    const tick = setInterval(() => ticks++, 20);
    const res = await post(a, id, { alias: 'web' });
    clearInterval(tick);
    expect(res.status).toBe(200);
    const folder = path.join(config.worktreesRoot, 'api', 'feat-x');
    expect(await res.json()).toEqual({
      ok: true,
      path: path.join(folder, 'web-repo'),
      branch: 'feat/x',
      created: true,
      from: 'main',
      imported: false, // neither repo has a CLAUDE.md
      // What the checkout warned about in the child reaches the answer (this repo has no upstream).
      warnings: [expect.stringMatching(/Could not pull 'main'/)],
    });
    expect(findSession(loadHistory(), 'api', 'feat/x')?.repos).toEqual(['api', 'web']);
    expect(opts.note).toHaveBeenCalledWith(id, expect.stringContaining('Added repo web'));
    expect(ticks).toBeGreaterThan(5); // nothing here waited on git
  }, 240_000);
});

describe("the route's real release (web-server wires scopeReleaser)", () => {
  it('lets go of the old scope keeping its turn refs, which the add moves', () => {
    const releaseSessionScope = vi.fn();
    void scopeReleaser({ releaseSessionScope })('s1', ['/a', '/b']);
    expect(releaseSessionScope).toHaveBeenCalledWith(['/a', '/b'], false);
    // No scope API yet (work web still starting): nothing to let go of.
    expect(() => scopeReleaser(undefined)('s1', ['/a'])).not.toThrow();
  });
});
