import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  discardReply,
  draftCounts,
  listReplies,
  markPostedAnswered,
  postDrafts,
  postReply,
  postedSince,
  rememberSent,
  saveDraft,
} from '../../../src/core/pr/pr-replies.js';
import type { SessionCi } from '../../../src/core/api-types.js';
import { mountPrReplyRoutes, openThreadsOfCi } from '../../../src/server/routes/pr-reply-routes.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { withDb, purgeSessionRows } from '../../../src/core/platform/db.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-replies-'));
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const T1 = 'PRRT_kwDOabc123';
const T2 = 'PRRT_kwDOdef456';
const thread = (threadId: string, over = {}) => ({
  threadId,
  repo: 'api',
  prNumber: 7,
  url: `https://github.com/o/api/pull/7#${threadId}`,
  where: 'src/a.ts:3',
  reviewer: 'copilot-pull-request-reviewer',
  excerpt: 'Use a const here',
  ...over,
});

/** The check before posting (`threadRefusal`): the thread as GitHub has it now, and who you are. */
const isThreadRead = (args: string[]) => args.some((a) => a.includes('viewer { login }'));
const threadNow = (o: { me?: string; last?: string; resolved?: boolean } = {}) => ({
  code: 0,
  stdout: JSON.stringify({
    data: {
      viewer: { login: o.me ?? 'me' },
      node: { isResolved: o.resolved ?? false, comments: { nodes: [{ author: { login: o.last ?? 'reviewer' } }] } },
    },
  }),
  stderr: '',
});

/** A fake gh that records its argv (the read before posting answered, not recorded). */
function gh(fail = false) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    if (isThreadRead(args)) return threadNow();
    calls.push([cmd, ...args]);
    if (fail) return { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' };
    return {
      code: 0,
      stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: 'https://github.com/o/api/pull/7#reply' } } } }),
      stderr: '',
    };
  };
  return { run, calls };
}

describe('reply drafts', () => {
  it('only threads handed to the session can be answered; a draft is saved and counted', () => {
    rememberSent('s1', [thread(T1), thread(T2)]);
    expect(saveDraft('s1', 'PRRT_notours', 'x')).toMatchObject({
      ok: false,
      error: expect.stringContaining("wasn't handed to this session"),
    });
    expect(saveDraft('s1', 'not-a-thread', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('not a review thread id') });
    expect(saveDraft('s1', T1, '   ')).toMatchObject({ ok: false, error: 'the reply is empty' });
    expect(saveDraft('s2', T1, 'Fixed')).toMatchObject({ ok: false }); // another session's thread
    expect(saveDraft('s1', T1, ' Fixed in abc1234: now a const. ')).toMatchObject({
      ok: true,
      reply: { status: 'draft', draft: 'Fixed in abc1234: now a const.' },
    });
    expect(listReplies('s1').map((r) => [r.threadId, r.status])).toEqual([
      [T1, 'draft'],
      [T2, 'sent'],
    ]);
    expect(draftCounts().get('s1')).toBe(1);
  });

  it('a thread handed over again (a reviewer answered) starts over', () => {
    rememberSent('s1', [thread(T1)]);
    saveDraft('s1', T1, 'Fixed');
    rememberSent('s1', [thread(T1, { excerpt: 'Still not a const' })]);
    expect(listReplies('s1')[0]).toMatchObject({ status: 'sent', draft: null, excerpt: 'Still not a const' });
  });

  it('posting runs gh with argv (raw -f strings), resolves when asked, and cannot post twice', async () => {
    rememberSent('s1', [thread(T1)]);
    saveDraft('s1', T1, 'draft');
    const g = gh();
    const body = 'Fixed — see @alice\'s note; a=b "quoted"';
    const r = await postReply('s1', T1, body, { resolve: true, cwd: home, run: g.run });
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/api/pull/7#reply', resolved: true });
    expect(g.calls[0].slice(0, 3)).toEqual(['gh', 'api', 'graphql']);
    expect(g.calls[0]).toContain(`threadId=${T1}`);
    expect(g.calls[0]).toContain(`body=${body}`); // one argv entry, no shell, no @file reading (-f)
    expect(g.calls[0].filter((a) => a === '-F')).toEqual([]);
    expect(g.calls[1].join(' ')).toContain('resolveReviewThread');
    expect(listReplies('s1')[0]).toMatchObject({ status: 'posted', draft: body, resolved: true });
    expect(await postReply('s1', T1, body, { resolve: false, cwd: home, run: g.run })).toEqual({ ok: false, error: 'already posted' });
    expect(saveDraft('s1', T1, 'again')).toMatchObject({ ok: false, error: expect.stringContaining('already posted') });
  });

  it("never answers your own last word, nor a thread resolved meanwhile; when GitHub can't say, nothing goes out (reported: a PR author's Claude answered his own comment)", async () => {
    rememberSent('s1', [thread(T1)]);
    saveDraft('s1', T1, 'Agreed, and worth stating plainly…');
    const posted: string[][] = [];
    const runWith =
      (answer: Awaited<ReturnType<CommandRunner>>): CommandRunner =>
      async (_cmd, args) => {
        if (isThreadRead(args)) return answer;
        posted.push(args);
        return { code: 0, stdout: '{}', stderr: '' };
      };
    const post = (answer: Awaited<ReturnType<CommandRunner>>) =>
      postReply('s1', T1, 'Agreed', { resolve: true, cwd: home, run: runWith(answer) });
    expect(await post(threadNow({ me: 'jureperak', last: 'JurePerak' }))).toEqual({
      ok: false,
      error: 'the last word in this thread is already yours (@jureperak): a reply would answer yourself',
    });
    expect(await post(threadNow({ resolved: true }))).toMatchObject({ ok: false, error: expect.stringContaining('resolved') });
    expect(await post({ code: 1, stdout: '', stderr: 'HTTP 401' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('HTTP 401'),
    });
    expect(await post({ code: 0, stdout: '{"data":{}}', stderr: '' })).toMatchObject({ ok: false });
    expect(posted).toEqual([]);
    expect(listReplies('s1')[0].status).toBe('draft');
  });

  it('a failed post keeps the draft and says why', async () => {
    rememberSent('s1', [thread(T1)]);
    saveDraft('s1', T1, 'draft');
    expect(await postReply('s1', T1, 'draft', { resolve: false, cwd: home, run: gh(true).run })).toEqual({
      ok: false,
      error: 'HTTP 403: Resource not accessible',
    });
    expect(listReplies('s1')[0].status).toBe('draft');
  });

  it('postDrafts (`work pr post`) posts the drafts as they stand — your dashboard edit included — and reports each', async () => {
    const s = { target: 'api', branch: 'fix/x', paths: [home] };
    const id = sessionIdFor(s);
    rememberSent(id, [thread(T1), thread(T2)]);
    saveDraft(id, T1, 'Claude wrote this');
    saveDraft(id, T1, 'You edited this'); // the dashboard's PUT saves through the same function
    saveDraft(id, T2, 'Second');
    let n = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (isThreadRead(args)) return threadNow();
      if (args.some((a) => a.includes('resolveReviewThread'))) return { code: 0, stdout: '{}', stderr: '' };
      return ++n === 2 ? { code: 1, stdout: '', stderr: 'HTTP 502' } : gh().run(cmd, args, home);
    };
    const r = await postDrafts(s, listReplies(id), true, run);
    expect(r.posted.map((p) => [p.threadId, p.resolved])).toEqual([[T1, true]]);
    expect(r.failed).toEqual([{ threadId: T2, error: 'HTTP 502' }]);
    expect(listReplies(id).map((x) => [x.threadId, x.status, x.draft])).toEqual([
      [T1, 'posted', 'You edited this'],
      [T2, 'draft', 'Second'], // a failed one stays a draft
    ]);
  });

  it('go with the session, and discard removes one', () => {
    rememberSent('s1', [thread(T1), thread(T2)]);
    expect(discardReply('s1', T2)).toBe(true);
    expect(listReplies('s1')).toHaveLength(1);
    withDb((d) => purgeSessionRows(d, 's1'));
    expect(listReplies('s1')).toEqual([]);
  });
});

describe('reply routes', () => {
  const session: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: [], createdAt: 'x', lastAccessedAt: 'x' };
  function app(run: CommandRunner) {
    const events: string[] = [];
    const a = new Hono();
    mountPrReplyRoutes(a, { broadcast: (e) => events.push(e), run });
    return { a, events };
  }
  const send = (a: Hono, method: string, url: string, body?: unknown) =>
    a.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  it('the open threads, from the PR watch’s state: open PRs only (a merged PR’s threads don’t wait on you)', () => {
    const t = (threadId: string) => ({ threadId, repo: 'api', prNumber: 7, url: 'u', where: null, reviewer: 'r', excerpt: 'e' });
    const pr = (state: string) =>
      ({ number: 7, url: 'u', state, isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'a' }) as never;
    expect(
      openThreadsOfCi({
        checkedAt: '',
        repos: [
          { name: 'web', pr: pr('OPEN'), done: false, threads: [t('PRRT_a')] },
          { name: 'api', pr: pr('MERGED'), done: true, threads: [t('PRRT_b')] },
          { name: 'docs', pr: null, done: true },
        ],
      }).map((x) => x.threadId),
    ).toEqual(['PRRT_a']);
    expect(openThreadsOfCi(null)).toEqual([]);
  });

  it('GET also lists the open threads that have no draft (`waiting`), from the PR watch', async () => {
    session.paths = [home];
    saveHistory([session]);
    const id = sessionIdFor(session);
    rememberSent(id, [thread(T1), thread(T2)]);
    saveDraft(id, T1, 'Fixed');
    const open = [T1, T2].map((threadId) => ({ threadId, repo: 'api', prNumber: 7, url: 'u', where: null, reviewer: 'r', excerpt: 'e' }));
    const a = new Hono();
    mountPrReplyRoutes(a, { broadcast: () => {}, openThreads: (sid) => (sid === id ? open : []) });
    const body = (await (await a.request(`/api/sessions/${id}/replies`)).json()) as { waiting: Array<{ threadId: string }> };
    expect(body.waiting.map((t) => t.threadId)).toEqual([T2]); // T1 has a draft to post
    const none = new Hono();
    mountPrReplyRoutes(none, { broadcast: () => {} });
    expect(((await (await none.request(`/api/sessions/${id}/replies`)).json()) as { waiting: unknown[] }).waiting).toEqual([]);
  });

  it('list, edit, post and discard; unknown sessions and bad thread ids are refused', async () => {
    session.paths = [home];
    saveHistory([session]);
    const id = sessionIdFor(session);
    rememberSent(id, [thread(T1), thread(T2)]);
    const g = gh();
    const { a, events } = app(g.run);
    expect((await (await a.request(`/api/sessions/${id}/replies`)).json()).replies).toHaveLength(2);
    expect((await a.request('/api/sessions/nope/replies')).status).toBe(404);
    expect((await send(a, 'PUT', `/api/sessions/${id}/replies/${T1}`, { body: 'Fixed' })).status).toBe(200);
    expect((await send(a, 'POST', `/api/sessions/${id}/replies/${T1}/post`, { body: 'Fixed!', resolve: false })).status).toBe(200);
    expect(g.calls).toHaveLength(1); // no resolve
    expect((await send(a, 'POST', `/api/sessions/${id}/replies/${T2}/post`, {})).status).toBe(400);
    expect((await send(a, 'DELETE', `/api/sessions/${id}/replies/not-a-thread`)).status).toBe(400);
    expect((await send(a, 'DELETE', `/api/sessions/${id}/replies/${T2}`)).status).toBe(200);
    expect(events).toContain('replies-changed');
    expect((await send(a, 'POST', '/api/replies-changed', { sessionId: id })).status).toBe(200);
  });

  /** A PR watch whose last check (at `checkedAt`) still lists both threads as waiting. */
  function fakeWatch(id: string, checkedAt: string) {
    const answered: string[] = [];
    const ci: SessionCi = { checkedAt, repos: [] };
    return {
      answered,
      watch: { state: (sid: string) => (sid === id ? ci : null), answered: (_sid: string, t: string) => void answered.push(t) },
    };
  }

  it('a reply posted from the dashboard leaves the PR watch’s check at once: the thread no longer waits on you', async () => {
    session.paths = [home];
    saveHistory([session]);
    const id = sessionIdFor(session);
    rememberSent(id, [thread(T1), thread(T2)]);
    const w = fakeWatch(id, new Date(Date.now() - 60_000).toISOString());
    const a = new Hono();
    mountPrReplyRoutes(a, { broadcast: () => {}, run: gh().run, watch: w.watch });
    expect((await send(a, 'POST', `/api/sessions/${id}/replies/${T1}/post`, { body: 'Fixed', resolve: true })).status).toBe(200);
    expect(w.answered).toEqual([T1]);
  });

  it('a reply `work pr post` posted (it calls /api/replies-changed) leaves it too — read from what was posted, not the request', async () => {
    session.paths = [home];
    saveHistory([session]);
    const id = sessionIdFor(session);
    rememberSent(id, [thread(T1), thread(T2)]);
    const w = fakeWatch(id, new Date(Date.now() - 60_000).toISOString());
    const a = new Hono();
    mountPrReplyRoutes(a, { broadcast: () => {}, watch: w.watch });
    // Nothing posted yet: a nudge answers nothing.
    expect((await send(a, 'POST', '/api/replies-changed', { sessionId: id })).status).toBe(200);
    expect(w.answered).toEqual([]);
    saveDraft(id, T2, 'Leaving it: it was already so before.');
    await postDrafts(
      session,
      listReplies(id).filter((r) => r.status === 'draft'),
      true,
      gh().run,
    );
    expect((await send(a, 'POST', '/api/replies-changed', { sessionId: id })).status).toBe(200);
    expect(w.answered).toEqual([T2]);
  });
});

describe('postedSince / markPostedAnswered', () => {
  const reply = (threadId: string, status: 'draft' | 'posted', postedAt?: string) =>
    ({ threadId, status, ...(postedAt ? { postedAt } : {}) }) as never;
  it('only replies posted after the watch last read GitHub: one it has seen since is its own to judge', () => {
    const replies = [reply('A', 'posted', '2026-10-05T13:03:21Z'), reply('B', 'posted', '2026-10-05T12:00:00Z'), reply('C', 'draft')];
    expect(postedSince(replies, '2026-10-05T13:00:00Z')).toEqual(['A']);
    expect(postedSince(replies, '2026-10-05T13:05:00Z')).toEqual([]);
    expect(postedSince(replies, null)).toEqual(['A', 'B']);
  });

  it('marks each with the watch, and says which', async () => {
    const s: WorktreeSession = { target: 'api', branch: 'feat/y', isGroup: false, paths: [home], createdAt: 'x', lastAccessedAt: 'x' };
    saveHistory([s]);
    const id = sessionIdFor(s);
    rememberSent(id, [thread(T1)]);
    saveDraft(id, T1, 'Fixed');
    await postDrafts(s, listReplies(id), true, gh().run);
    const marked: string[] = [];
    const watch = {
      state: () => ({ checkedAt: '2026-01-01T00:00:00Z', repos: [] }),
      answered: (_i: string, t: string) => void marked.push(t),
    };
    expect(markPostedAnswered(id, watch)).toEqual([T1]);
    expect(marked).toEqual([T1]);
  });
});
