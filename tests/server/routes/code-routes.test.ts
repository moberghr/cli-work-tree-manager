import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { git } from '../../../src/core/git/git.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { mountCodeRoutes } from '../../../src/server/routes/code-routes.js';
import type { CodeFileWire, CodeFilesWire } from '../../../src/core/api-types.js';

let tmp: string;
let session: WorktreeSession;
const app = new Hono();
mountCodeRoutes(app);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-routes-'));
  const repo = path.join(tmp, 'api');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  session = {
    target: 'api',
    isGroup: false,
    branch: 'feat/x',
    paths: [repo],
    createdAt: '2026-10-14T00:00:00Z',
    lastAccessedAt: '2026-10-14T00:00:00Z',
  };
  saveHistory([session]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the Code tab routes', () => {
  it("GET files: the repo's files as git lists them", async () => {
    const res = await app.request(`/api/sessions/${sessionIdFor(session)}/files`);
    expect(res.status).toBe(200);
    const w = (await res.json()) as CodeFilesWire;
    expect(w.repos.map((r) => [r.name, r.files])).toEqual([['api', ['.gitignore', 'a.ts']]]);
  });

  it("GET file: one listed file's text; never an ignored one; a path is required", async () => {
    const id = sessionIdFor(session);
    const ok = await app.request(`/api/sessions/${id}/file?repo=api&path=a.ts`);
    expect(((await ok.json()) as CodeFileWire).text).toBe('export const a = 1;\n');
    expect((await app.request(`/api/sessions/${id}/file?repo=api&path=.env`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/file?repo=api`)).status).toBe(400);
  });

  it('an unknown session is 404', async () => {
    expect((await app.request('/api/sessions/nope/files')).status).toBe(404);
    expect((await app.request('/api/sessions/nope/file?repo=api&path=a.ts')).status).toBe(404);
  });
});
