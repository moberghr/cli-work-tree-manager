import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { upsertSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { disposeAllScopes } from '../../src/core/scope-manager.js';
import { rememberSent, saveDraft } from '../../src/core/pr-replies.js';
import { startWebServer, type WebServerHandle } from '../../src/core/web-server.js';
import type { RepliesWire } from '../../src/core/api-types.js';

/** GET /api/sessions/:id/replies against the real server: the drafts, and the open threads with none (wired to the PR watch). */

let home: string;
let server: WebServerHandle;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-real-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  await upsertSession('api', false, 'feat/x', [wt]);
  server = await startWebServer({ lean: true });
}, 60_000);
afterEach(async () => {
  await server.stop();
  disposeAllScopes();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('GET /api/sessions/:id/replies (real server)', () => {
  it('answers with the drafts and a `waiting` list (empty until the PR watch has read the PR)', async () => {
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    rememberSent(id, [{ threadId: 'PRRT_kwDOreal1', repo: 'api', prNumber: 7, url: 'u', where: null, reviewer: 'r', excerpt: 'e' }]);
    saveDraft(id, 'PRRT_kwDOreal1', 'Fixed in abc');
    const res = await fetch(server.url.replace(/\/$/, '') + `/api/sessions/${id}/replies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepliesWire;
    expect(body.replies).toMatchObject([{ threadId: 'PRRT_kwDOreal1', status: 'draft', draft: 'Fixed in abc' }]);
    expect(body.waiting).toEqual([]);
  });
});
