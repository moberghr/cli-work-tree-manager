import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionReviewRoutes } from '../../../src/server/routes/session-review-routes.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { prepareLocalReview } from '../../../src/core/review/local-review.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { SessionReviewWire } from '../../../src/core/api-types.js';

/** A session's own changes as a review: prepare on a click, read it and its diff, hand its notes to its agent. */
const HANDLER = 'src/Shop.Core/Handlers/RefundHandler.cs';
const files = parseGitDiff(
  [
    `diff --git a/${HANDLER} b/${HANDLER}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${HANDLER}`,
    '@@ -0,0 +1,3 @@',
    '+public class RefundHandler {',
    '+    public bool Handle(int amount) => amount > 0;',
    '+}',
    '',
  ].join('\n'),
);
const answer = JSON.stringify({
  summary: 'Refunds.',
  stories: [{ title: 'Refunds are accepted', what: 'x', why: 'y', risk: 'z', riskLevel: 3, files: [HANDLER], flags: [] }],
  notes: [{ path: HANDLER, line: 2, body: 'A zero amount is refused silently.' }],
});

let home: string;
let id: string;
let archivedId: string;
let events: string[];
let told: Array<{ id: string; body: string }>;
let changed: boolean;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-local-review-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  const live: WorktreeSession = {
    target: 'api',
    branch: 'feat/x',
    isGroup: false,
    paths: [path.join(home, 'wt')],
    createdAt: 'x',
    lastAccessedAt: 'x',
  };
  const archived: WorktreeSession = { ...live, branch: 'feat/old', archivedAt: '2026-11-01T00:00:00Z' };
  saveHistory([live, archived]);
  id = sessionIdFor(live);
  archivedId = sessionIdFor(archived);
  events = [];
  told = [];
  changed = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function app(
  tell: (sessionId: string, body: string) => Promise<void> = async (sessionId, body) => void told.push({ id: sessionId, body }),
) {
  const a = new Hono();
  mountSessionReviewRoutes(a, {
    prepare: (session, repo) =>
      prepareLocalReview(session, repo, {
        diff: () => ({ repos: [{ name: 'api', files: changed ? files : [] }], resolvedBase: 'origin/main' }),
        agent: async () => answer,
      }),
    tell,
    broadcast: (e) => void events.push(e),
  });
  return a;
}
const post = (a: Hono, tail: string, body: unknown = {}, session = id) =>
  a.request(`/api/sessions/${session}/review${tail}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const state = async (a: Hono) => (await (await a.request(`/api/sessions/${id}/review`)).json()) as SessionReviewWire;
const settled = () => new Promise((r) => setTimeout(r, 20));

describe('session review routes', () => {
  it('none until asked; POST answers running at once, then it is ready, announced, with its diff', async () => {
    const a = app();
    expect(await state(a)).toEqual({ status: 'none', repo: null, repos: [] });
    expect((await a.request(`/api/sessions/${id}/review/diff`)).status).toBe(404);
    const started = await post(a, '');
    expect(started.status).toBe(200);
    expect(((await started.json()) as SessionReviewWire).status).toBe('running');
    await settled();
    const ready = await state(a);
    expect(ready).toMatchObject({ status: 'ready', repo: 'api', repos: ['api'] });
    expect(ready.review).toMatchObject({ number: 0, author: 'you', title: 'Local changes on feat/x', aiStep: 'done' });
    expect(events).toEqual(['session-review-changed']);
    const diff = (await (await a.request(`/api/sessions/${id}/review/diff`)).json()) as { files: Array<{ path: string }> };
    expect(diff.files.map((f) => f.path)).toEqual([HANDLER]);
  });

  it('nothing changed: it fails saying so, never an empty review', async () => {
    changed = false;
    const a = app();
    await post(a, '');
    await settled();
    expect(await state(a)).toMatchObject({ status: 'failed', error: 'Nothing has changed on this branch since origin/main.' });
  });

  it('send hands the notes you kept to the session’s agent, fenced; none kept, or nothing prepared, is refused', async () => {
    const a = app();
    expect((await post(a, '/send')).status).toBe(409); // nothing prepared
    await post(a, '');
    await settled();
    const draft = (await state(a)).review!.drafts[0];
    const sent = await post(a, '/send', { ids: [draft.id] });
    expect(await sent.json()).toEqual({ ok: true, sent: 1 });
    expect(told).toHaveLength(1);
    expect(told[0].id).toBe(id);
    expect(told[0].body).toContain(`- ${HANDLER}:2: <<< A zero amount is refused silently. >>>`);
    expect((await post(a, '/send', { ids: [] })).status).toBe(409);
    expect((await post(a, '/send', { ids: 'all' })).status).toBe(400);
    expect(told).toHaveLength(1);
    // No ids: all of them.
    expect(await (await post(a, '/send')).json()).toEqual({ ok: true, sent: 1 });
  });

  it('a note that can’t be delivered says why', async () => {
    const a = app(async () => {
      throw new Error('posting the note failed: 500');
    });
    await post(a, '');
    await settled();
    const res = await post(a, '/send');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'posting the note failed: 500' });
  });

  it('refuses an archived session, an unknown one and a repo that isn’t a string', async () => {
    const a = app();
    expect((await post(a, '', {}, archivedId)).status).toBe(409);
    expect((await post(a, '', {}, 'nope')).status).toBe(404);
    expect((await a.request('/api/sessions/nope/review')).status).toBe(404);
    expect((await a.request('/api/sessions/nope/review/diff')).status).toBe(404);
    expect((await post(a, '/send', {}, 'nope')).status).toBe(404);
    expect((await post(a, '', { repo: 3 })).status).toBe(400);
  });
});
