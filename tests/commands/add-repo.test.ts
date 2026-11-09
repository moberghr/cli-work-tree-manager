import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** `work add-repo`: through a running work web (faked here), else in-process with the note left for Claude. */

let answer: () => unknown = () => ({ ok: false, status: 0, error: 'work web is not running' });
const calls: Array<{ method: string; route: string; body: unknown }> = [];
vi.mock('../../src/core/platform/web-discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/platform/web-discovery.js')>()),
  callWorkWeb: vi.fn(async (method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    return answer();
  }),
}));

// A note that can't be left (the comment store refuses), when a test says so.
const noteFails = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/core/comments/comment-file-store.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/comments/comment-file-store.js')>();
  return {
    ...real,
    getCommentFileStore: (store: string) => {
      const s = real.getCommentFileStore(store);
      return noteFails.on
        ? {
            ...s,
            post: () => {
              throw new Error('database is locked');
            },
          }
        : s;
    },
  };
});

const { git } = await import('../../src/core/git/git.js');
const { saveConfig } = await import('../../src/core/platform/config.js');
const { findSession, loadHistory } = await import('../../src/core/sessions/history.js');
const { sessionIdFor } = await import('../../src/core/sessions/session-id.js');
const { setupWorktree } = await import('../../src/core/worktree/worktree.js');
const { readStoreComments } = await import('../../src/core/comments/comment-file-store.js');
const { addRepoCommand } = await import('../../src/commands/add-repo.js');
const { flatFolderName } = await import('../../src/core/worktree/session-folder.js');

let fixture: string;
let home: string;
let folder: string;
const out: string[] = [];
const errors: string[] = [];
const id = sessionIdFor({ target: 'api', branch: 'feat/x' });

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'add-repo-cmd-fixture-'));
  for (const name of ['api', 'web']) {
    const dir = path.join(fixture, `${name}-repo`);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${name}\n`);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
    // An origin, as a real repo has (its own checkout's pull has an upstream to pull from).
    const origin = path.join(fixture, `${name}.git`);
    git(['init', '-q', '--bare', '-b', 'main', origin], fixture);
    git(['remote', 'add', 'origin', origin], dir);
    git(['push', '-q', '-u', 'origin', 'main'], dir);
  }
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'add-repo-cmd-')));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.cpSync(fixture, path.join(home, 'src'), { recursive: true });
  const config = {
    worktreesRoot: path.join(home, 'wt'),
    repos: { api: path.join(home, 'src', 'api-repo'), web: path.join(home, 'src', 'web-repo') },
    groups: {},
    copyFiles: [],
    sessionFolders: true,
  };
  saveConfig(config);
  await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
  folder = path.join(config.worktreesRoot, flatFolderName('api', 'feat/x'));
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  out.length = 0;
  errors.length = 0;
  calls.length = 0;
  answer = () => ({ ok: false, status: 0, error: 'work web is not running' });
  noteFails.on = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * The session for "this folder", for the tests that run no git: cross-spawn on Windows
 * chdirs into a spawn's cwd and back to `process.cwd()`, so a mocked one would leave this
 * process inside the session folder (which then can't be deleted). Those that run git name it.
 */
const inFolder = () => vi.spyOn(process, 'cwd').mockReturnValue(folder);
const named = { target: 'api', branch: 'feat/x' };
const run = (argv: Record<string, unknown>) => (addRepoCommand.handler as (argv: unknown) => Promise<void>)({ _: [], ...argv });
const repos = () => findSession(loadHistory(), 'api', 'feat/x')?.repos;

describe('work add-repo', () => {
  it('goes through a running work web, for the session of this folder', async () => {
    inFolder();
    answer = () => ({ ok: true, body: { ok: true, path: path.join(folder, 'web-repo'), branch: 'feat/x', created: true, from: 'main' } });
    await run({ alias: 'web', base: 'main' });
    expect(calls).toEqual([{ method: 'POST', route: `/api/sessions/${id}/repos`, body: { alias: 'web', base: 'main' } }]);
    expect(out.join('\n')).toMatch(/Added web to api · feat\/x/);
    expect(repos()).toEqual(['api']); // work web did it, not this process
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('with no work web, adds it here and leaves the note for its Claude', async () => {
    await run({ alias: 'web', ...named });
    expect(repos()).toEqual(['api', 'web']);
    expect(fs.existsSync(path.join(folder, 'web-repo', 'CLAUDE.md'))).toBe(true);
    const notes = readStoreComments(id);
    expect(notes).toEqual([
      expect.objectContaining({ side: 'general', status: 'published', body: expect.stringContaining('Added repo web to this session') }),
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  }, 60_000);

  it("work web's warnings are printed under the outcome; the add stands", async () => {
    answer = () => ({
      ok: true,
      body: { ok: true, path: path.join(folder, 'web-repo'), branch: 'feat/x', created: false, warnings: ["the Diff tab's turns: x"] },
    });
    await run({ alias: 'web', ...named });
    expect(out.join('\n')).toMatch(/Added web to api · feat\/x/);
    expect(out).toContain("  the Diff tab's turns: x");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json through work web: its answer as it came', async () => {
    const body = {
      ok: true,
      path: path.join(folder, 'web-repo'),
      branch: 'feat/x',
      created: true,
      from: 'main',
      imported: true,
      warnings: [],
    };
    answer = () => ({ ok: true, body });
    await run({ alias: 'web', ...named, json: true });
    expect(JSON.parse(out.at(-1)!)).toEqual(body);
  });

  it("with no work web, a note that can't be left is a warning, never the add failing", async () => {
    noteFails.on = true;
    await run({ alias: 'web', ...named });
    expect(repos()).toEqual(['api', 'web']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.join('\n')).toMatch(/couldn't leave the note for its Claude: database is locked/);
    expect(out.join('\n')).not.toMatch(/told on its next turn/);
  }, 60_000);

  it("work web that didn't answer in time: says so, does nothing here", async () => {
    answer = () => ({ ok: false, status: -1, error: 'work web did not answer in time' });
    await run({ alias: 'web', ...named });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/did not answer in time/);
    expect(repos()).toEqual(['api']);
  });

  it("work web's refusal is printed", async () => {
    answer = () => ({ ok: false, status: 409, error: 'web is in this session already' });
    await run({ alias: 'web', ...named });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/already/);
  });

  it("--in-process --json (work web's child): the outcome as JSON, no note, no call to work web", async () => {
    await run({ alias: 'web', 'session-id': id, 'in-process': true, json: true });
    expect(calls).toEqual([]);
    expect(JSON.parse(out.at(-1)!)).toEqual({
      ok: true,
      path: path.join(folder, 'web-repo'),
      branch: 'feat/x',
      created: true,
      from: 'main',
      imported: true,
      warnings: [],
    });
    expect(readStoreComments(id)).toEqual([]);
    out.length = 0;
    await run({ alias: 'web', 'session-id': id, 'in-process': true, json: true });
    // A refusal carries its status, for the route to answer with.
    expect(JSON.parse(out.at(-1)!)).toEqual({ error: 'web is in this session already', status: 409 });
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it('outside any session: says to pass one', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
    await run({ alias: 'web' });
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});
