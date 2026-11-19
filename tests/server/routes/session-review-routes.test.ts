import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionReviewRoutes } from '../../../src/server/routes/session-review-routes.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { localSignature, prepareLocalReview } from '../../../src/core/review/local-review.js';
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
    signature: (_s, r) =>
      localSignature({ repos: [{ name: 'api', files: changed ? files : [] }], resolvedBase: 'origin/main' }, r ?? undefined),
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
    // The row's refresh at the start, then at the finish: the tab's event, the row's refresh, and a notification.
    expect(events).toEqual(['sessions-changed', 'session-review-changed', 'sessions-changed', 'notify']);
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

describe('GET /api/sessions/:id/review/current (have the changes moved since it was prepared?)', () => {
  it('none prepared: 404; the same changes: current; other changes: not; an unknown session: 404', async () => {
    const a = app();
    expect((await a.request(`/api/sessions/${id}/review/current`)).status).toBe(404);
    await post(a, '');
    await settled();
    expect(await (await a.request(`/api/sessions/${id}/review/current`)).json()).toEqual({ current: true });
    // The session went on working: what the review read is no longer what is there.
    changed = false;
    expect(await (await a.request(`/api/sessions/${id}/review/current`)).json()).toEqual({ current: false });
    expect((await a.request('/api/sessions/nope/review/current')).status).toBe(404);
  });
});

describe('which notes were sent and dismissed (kept with the review)', () => {
  const note = async (a: Hono) => (await state(a)).review!.drafts[0].id;

  it('a send is recorded on the review, and the pages are told', async () => {
    const a = app();
    await post(a, '');
    await settled();
    const one = await note(a);
    events = [];
    expect((await post(a, '/send', { ids: [one] })).status).toBe(200);
    expect((await state(a)).sent).toEqual([one]);
    expect(events).toEqual(['session-review-changed']);
  });

  it('dismiss takes a note out (and undo brings it back); a send of all leaves the dismissed ones out', async () => {
    const a = app();
    await post(a, '');
    await settled();
    const one = await note(a);
    const res = await post(a, '/dismiss', { id: one });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionReviewWire).dismissed).toEqual([one]);
    // The only note is dismissed: there is none to hand over.
    expect((await post(a, '/send')).status).toBe(409);
    expect(told).toEqual([]);
    expect(((await (await post(a, '/dismiss', { id: one, undo: true })).json()) as SessionReviewWire).dismissed).toEqual([]);
    expect((await post(a, '/send')).status).toBe(200);
  });

  it('refuses a note the review doesn’t have, a body with no id, and an unknown session', async () => {
    const a = app();
    await post(a, '');
    await settled();
    expect((await post(a, '/dismiss', { id: 'nope' })).status).toBe(404);
    expect((await post(a, '/dismiss', {})).status).toBe(400);
    expect((await post(a, '/dismiss', { id: 'd1' }, 'nope')).status).toBe(404);
  });
});

describe('a finished review is announced, and Mark seen clears it', () => {
  it('ready: the session’s row is told to refresh and a notification goes out; seen is a POST that clears it once', async () => {
    const sent: Array<{ event: string; data: unknown }> = [];
    const a = new Hono();
    const { row } = mountSessionReviewRoutes(a, {
      prepare: (session, repo) =>
        prepareLocalReview(session, repo, {
          diff: () => ({ repos: [{ name: 'api', files }], resolvedBase: 'origin/main' }),
          agent: async () => answer,
        }),
      signature: () => 'x',
      tell: async () => {},
      broadcast: (event, data) => void sent.push({ event, data }),
    });
    expect(row(id)).toBeNull();
    await post(a, '');
    expect(row(id)?.status).toBe('running');
    await settled();
    expect(row(id)).toMatchObject({ status: 'ready', seen: false });
    expect(sent.map((s) => s.event)).toEqual(['sessions-changed', 'session-review-changed', 'sessions-changed', 'notify']);
    expect(sent[3].data).toMatchObject({ sessionId: id, kind: 'review', title: 'feat/x: review ready' });
    sent.length = 0;
    // A GET changes nothing (§1.5): the review is still unseen after one.
    await a.request(`/api/sessions/${id}/review`);
    expect(row(id)?.seen).toBe(false);
    expect((await post(a, '/seen')).status).toBe(200);
    expect(row(id)?.seen).toBe(true);
    expect(sent.map((s) => s.event)).toEqual(['sessions-changed']);
    // Again: nothing to clear, nothing announced.
    await post(a, '/seen');
    expect(sent).toHaveLength(1);
    expect((await post(a, '/seen', {}, 'nope')).status).toBe(404);
  });
});
