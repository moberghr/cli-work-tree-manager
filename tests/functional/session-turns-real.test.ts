import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { git } from '../../src/core/git/git.js';
import { upsertSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import { disposeAllScopes } from '../../src/core/diff/scope-manager.js';
import { startWebServer, type WebServerHandle } from '../../src/server/web-server.js';

/**
 * "Last turn" end to end against the real work web server and real git:
 * a session's checkpoints come from its diff scope (created on demand),
 * each Stop-hook checkpoint is one turn, and the session diff route
 * serves a turn as a checkpoint range.
 */

vi.mock('../../src/core/diff/checkpoint-summary.js', () => ({
  summarizeCheckpoint: vi.fn(async () => 'mock summary'),
}));

let home: string;
let repo: string;
let server: WebServerHandle;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-real-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# v1\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  await upsertSession('repo', false, 'feat/x', [repo]);
  server = await startWebServer({ lean: true });
}, 60_000);
afterEach(async () => {
  await server.stop();
  disposeAllScopes();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const get = async <T = unknown>(p: string): Promise<{ status: number; body: T }> => {
  const res = await fetch(server.url.replace(/\/$/, '') + p);
  return { status: res.status, body: (await res.json()) as T };
};
const turnEnded = async () => {
  const res = await fetch(server.url.replace(/\/$/, '') + '/api/checkpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: repo }),
  });
  expect(res.status).toBe(200);
  // The next instruction opens a new step.
  await fetch(server.url.replace(/\/$/, '') + '/api/checkpoint/seal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: repo }),
  });
};
/** What a session's diff route answers (the fields these tests read). */
type DiffWire = {
  base?: string;
  repos: Array<{ name: string; files: Array<{ path: string; hunks: Array<{ newStart: number; newLines: number }> }> }>;
};
const files = (d: { repos: Array<{ files: Array<{ path: string }> }> }) => d.repos.flatMap((r) => r.files.map((f) => f.path)).sort();

describe('session turns', () => {
  it('each finished turn is a range the session diff can show on its own', async () => {
    const id = sessionIdFor({ target: 'repo', branch: 'feat/x' });

    // Opening the session (a GET) changes nothing: no scope, no baseline.
    const first = await get<{ entries: Array<{ id: number }> }>(`/api/sessions/${id}/checkpoints`);
    expect(first.status).toBe(200);
    expect(first.body.entries).toEqual([]);
    // Claude's first hook (a POST) creates the scope; the baseline lands
    // shortly after (announced over SSE — here we poll).
    await fetch(server.url.replace(/\/$/, '') + '/api/status-changed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repo }),
    });
    await expect
      .poll(async () => (await get<{ entries: Array<{ id: number }> }>(`/api/sessions/${id}/checkpoints`)).body.entries.map((e) => e.id), {
        timeout: 15_000,
      })
      .toEqual([0]);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'turn one\n');
    await turnEnded();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'turn two\n');
    await turnEnded();

    const { body } = await get<{ entries: Array<{ id: number }> }>(`/api/sessions/${id}/checkpoints`);
    const ids = body.entries.map((e) => e.id);
    expect(ids).toHaveLength(3);

    const last = await get<DiffWire>(`/api/sessions/${id}/diff?from=${ids[1]}&to=${ids[2]}`);
    expect(last.status).toBe(200);
    expect(last.body.base).toBe('range');
    expect(files(last.body)).toEqual(['b.txt']);

    const both = await get<DiffWire>(`/api/sessions/${id}/diff?from=${ids[0]}&to=${ids[2]}`);
    expect(files(both.body)).toEqual(['a.txt', 'b.txt']);

    // The plain scopes still work alongside.
    const uncommitted = await get<DiffWire>(`/api/sessions/${id}/diff?base=uncommitted`);
    expect(files(uncommitted.body)).toEqual(['a.txt', 'b.txt']);
  }, 60_000);

  it("lists the branch's commits beside the turns, and diffs a commit alone, or from a commit to a turn or the working tree", async () => {
    const id = sessionIdFor({ target: 'repo', branch: 'feat/x' });
    git(['checkout', '-q', '-b', 'feat/x'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'Add a'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).stdout;
    fs.writeFileSync(path.join(repo, 'b.txt'), 'uncommitted\n');

    const history = await get<{ commits: Array<{ repo: string; sha: string; subject: string }> }>(`/api/sessions/${id}/checkpoints`);
    expect(history.body.commits.map((c) => [c.repo, c.sha, c.subject])).toEqual([['repo', sha, 'Add a']]);

    const alone = await get<DiffWire>(`/api/sessions/${id}/diff?from=p:repo:${sha}&to=c:repo:${sha}`);
    expect(alone.status).toBe(200);
    expect(files(alone.body)).toEqual(['a.txt']);
    const toNow = await get<DiffWire>(`/api/sessions/${id}/diff?from=p:repo:${sha}&to=working`);
    expect(files(toNow.body)).toEqual(['a.txt', 'b.txt']);
    const uncommitted = await get<DiffWire>(`/api/sessions/${id}/diff?from=head&to=working`);
    expect(files(uncommitted.body)).toEqual(['b.txt']);

    // Anything else is refused, never handed to git.
    for (const bad of ['p:repo:HEAD~1', 'c:repo:--output=x', 'p:other:' + sha]) {
      expect((await get(`/api/sessions/${id}/diff?from=${encodeURIComponent(bad)}&to=working`)).status).toBe(400);
    }
  }, 60_000);

  it('404s for an unknown session', async () => {
    expect((await get('/api/sessions/nope/checkpoints')).status).toBe(404);
  });
});
