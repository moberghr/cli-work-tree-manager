import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { git } from '../../src/core/git/git.js';
import { upsertSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import { disposeAllScopes } from '../../src/core/diff/scope-manager.js';
import { clearCommentStoreCache } from '../../src/core/comments/comment-file-store.js';
import { startWebServer, type WebServerHandle } from '../../src/server/web-server.js';

/**
 * Revert against the real work web server and real git: the route finds
 * the change in the session's own Uncommitted diff, undoes it, and leaves
 * Claude a published note (delivered like any review comment).
 */

vi.mock('../../src/core/diff/checkpoint-summary.js', () => ({
  summarizeCheckpoint: vi.fn(async () => 'mock summary'),
}));

let home: string;
let repo: string;
let server: WebServerHandle;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-real-'));
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
  clearCommentStoreCache();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const get = async <T = unknown>(p: string): Promise<{ status: number; body: T }> => {
  const res = await fetch(server.url.replace(/\/$/, '') + p);
  return { status: res.status, body: (await res.json()) as T };
};
const post = async (p: string, body: unknown) => {
  const res = await fetch(server.url.replace(/\/$/, '') + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};
/** What a session's diff route answers (the fields these tests read). */
type DiffWire = {
  base?: string;
  repos: Array<{ name: string; files: Array<{ path: string; hunks: Array<{ newStart: number; newLines: number }> }> }>;
};
const id = () => sessionIdFor({ target: 'repo', branch: 'feat/x' });

describe('POST /api/sessions/:id/revert', () => {
  it('undoes one hunk, keeps the rest, and tells Claude', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    fs.writeFileSync(path.join(repo, 'README.md'), lines.join('\n') + '\n');
    git(['commit', '-q', '-am', 'more'], repo);
    lines[1] = 'TOP';
    lines[27] = 'BOTTOM';
    fs.writeFileSync(path.join(repo, 'README.md'), lines.join('\n') + '\n');

    const d = await get<DiffWire>(`/api/sessions/${id()}/diff?base=uncommitted`);
    const hunks = d.body.repos[0].files[0].hunks;
    expect(hunks).toHaveLength(2);
    const h = hunks[0];
    const r = await post(`/api/sessions/${id()}/revert`, {
      repo: 'repo',
      path: 'README.md',
      lines: { start: h.newStart, end: h.newStart + h.newLines - 1 },
    });
    expect(r.status).toBe(200);
    const text = fs.readFileSync(path.join(repo, 'README.md'), 'utf-8');
    expect(text).not.toContain('TOP');
    expect(text).toContain('BOTTOM');

    const { body } = await get<{ comments: Array<{ body: string; side: string; status: string; author: string }> }>(
      `/api/sessions/${id()}/comments`,
    );
    expect(body.comments).toEqual([
      expect.objectContaining({
        side: 'general',
        status: 'published',
        author: 'user',
        body: expect.stringContaining(`lines ${h.newStart}–${h.newStart + h.newLines - 1} of \`README.md\``),
      }),
    ]);
  }, 60_000);

  it('reverts a whole untracked file, and refuses what is no longer there', async () => {
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'tmp\n');
    expect((await post(`/api/sessions/${id()}/revert`, { repo: 'repo', path: 'scratch.txt', tell: false })).status).toBe(200);
    expect(fs.existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
    expect((await get<{ comments: unknown[] }>(`/api/sessions/${id()}/comments`)).body.comments).toEqual([]);

    const again = await post(`/api/sessions/${id()}/revert`, { repo: 'repo', path: 'scratch.txt' });
    expect(again.status).toBe(409);
    expect((await post(`/api/sessions/${id()}/revert`, { repo: 'elsewhere', path: 'x' })).status).toBe(404);
    expect((await post('/api/sessions/nope/revert', { repo: 'repo', path: 'x' })).status).toBe(404);
  }, 60_000);
});
