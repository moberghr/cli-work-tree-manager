import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  discardReply,
  draftCounts,
  draftReply,
  liveOpenThread,
  listReplies,
  markPostedAnswered,
  postDrafts,
  postReply,
  postedSince,
  rememberSent,
  retireResolvedReplies,
  saveDraft,
} from '../../../src/core/pr/pr-replies.js';
import type { SessionCi } from '../../../src/core/api-types.js';
import { createCiStore } from '../../../src/core/pr/pr-watch-store.js';
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
  it('only threads handed to the session (or listed open for it) can be answered; a draft is saved and counted', () => {
    rememberSent('s1', [thread(T1), thread(T2)]);
    expect(saveDraft('s1', 'PRRT_notours', 'x')).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't an open review thread of this session's pull requests"),
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

  it('a thread the PR watch lists as open can be drafted though no note handed it over ("Ask Claude to reply"; reported: feat/webhook-wallet)', () => {
    const ci = (threads: ReturnType<typeof thread>[]): SessionCi =>
      ({
        checkedAt: '2026-10-27T10:42:01.213Z',
        repos: [
          {
            name: 'api',
            pr: { number: 7, url: 'https://github.com/o/api/pull/7', state: 'OPEN', isDraft: false, checks: 'pass', headSha: 'abc' },
            done: false,
            openThreads: threads.length,
            threads,
          },
        ],
      }) as SessionCi;
    createCiStore().save('s1', ci([thread(T1, { reviewer: 'github-actions' })]));
    expect(saveDraft('s1', T1, 'Leaving this as is.')).toMatchObject({
      ok: true,
      reply: { threadId: T1, repo: 'api', prNumber: 7, reviewer: 'github-actions', status: 'draft', draft: 'Leaving this as is.' },
    });
    expect(listReplies('s1').map((r) => [r.threadId, r.status, r.url])).toEqual([[T1, 'draft', thread(T1).url]]);
    // Not listed for this session (another's, or not open any more): refused, nothing written.
    expect(saveDraft('s2', T1, 'x')).toMatchObject({ ok: false });
    expect(saveDraft('s1', T2, 'x')).toMatchObject({ ok: false });
    expect(listReplies('s2')).toEqual([]);
  });

  describe("a thread from the watch's list", () => {
    const ci = (threads: ReturnType<typeof thread>[], checkedAt = '2026-10-27T10:00:00.000Z'): SessionCi =>
      ({
        checkedAt,
        repos: [
          {
            name: 'api',
            pr: { number: 7, url: 'https://github.com/o/api/pull/7', state: 'OPEN', isDraft: false, checks: 'pass', headSha: 'abc' },
            done: false,
            openThreads: threads.length,
            threads,
          },
        ],
      }) as SessionCi;
    const posted = (postedAt: string) =>
      withDb((d) =>
        d
          .prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)')
          .run('s1', T1, JSON.stringify({ ...thread(T1), status: 'posted', draft: 'Done', sentAt: postedAt, postedAt })),
      );

    it("its row is stamped with the draft's clock", () => {
      createCiStore().save('s1', ci([thread(T1)]));
      const now = new Date('2026-10-27T11:00:00.000Z');
      expect(saveDraft('s1', T1, 'x', now)).toMatchObject({ ok: true, reply: { sentAt: now.toISOString(), draftedAt: now.toISOString() } });
    });

    it('answered before and listed open again since (the reviewer answered): starts over; listed only from before the reply: refused', () => {
      posted('2026-10-27T09:00:00.000Z');
      createCiStore().save('s1', ci([thread(T1, { excerpt: 'Still null here?' })], '2026-10-27T10:00:00.000Z'));
      expect(saveDraft('s1', T1, 'Now it is')).toMatchObject({
        ok: true,
        reply: { status: 'draft', draft: 'Now it is', excerpt: 'Still null here?' },
      });

      posted('2026-10-27T10:30:00.000Z'); // the last check is older than the reply: it may not have seen it
      expect(saveDraft('s1', T1, 'again')).toMatchObject({ ok: false, error: 'a reply to this thread was already posted' });
    });

    it('a session launched --unsafe drafts only what the watch handed it', () => {
      createCiStore().save('s1', ci([thread(T1)]));
      expect(saveDraft('s1', T1, 'x', new Date(), { unsafe: true })).toMatchObject({ ok: false });
      expect(listReplies('s1')).toEqual([]);
      rememberSent('s1', [thread(T1)]);
      expect(saveDraft('s1', T1, 'x', new Date(), { unsafe: true })).toMatchObject({ ok: true });
    });
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
    expect(await post(threadNow({ me: 'reviewer-a', last: 'Reviewer-A' }))).toEqual({
      ok: false,
      error: 'the last word in this thread is already yours (@reviewer-a): a reply would answer yourself',
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

describe('never stuck on a stale check: the thread read from GitHub now (liveOpenThread, draftReply)', () => {
  const T = 'PRRT_kwDOlive789';
  const repos = [
    { name: 'straumur-backend', path: '/wt/b', github: 'kvika/straumur-backend', branch: 'feat/api-key-origin' },
    { name: 'straumur-frontend', path: '/wt/f', github: 'kvika/straumur-frontend', branch: 'feat/api-key-origin' },
  ];
  /** gh's answer for the thread: on kvika/straumur-frontend #2000, from feat/api-key-origin, its last word the bot's. */
  const answer = (over: { repo?: string; head?: string; resolved?: boolean; lastBy?: string } = {}) =>
    JSON.stringify({
      data: {
        viewer: { login: 'domagojmedo' },
        node: {
          isResolved: over.resolved ?? false,
          path: 'src/apiKeys.ts',
          line: 42,
          first: { nodes: [{ author: { login: 'github-actions' }, body: 'Allow http:// origins?', url: 'https://x/c1' }] },
          last: { nodes: [{ author: { login: over.lastBy ?? 'github-actions' }, url: 'https://x/c2' }] },
          pullRequest: {
            number: 2000,
            url: 'https://github.com/kvika/straumur-frontend/pull/2000',
            headRefName: over.head ?? 'feat/api-key-origin',
            repository: { nameWithOwner: over.repo ?? 'kvika/Straumur-Frontend' },
          },
        },
      },
    });
  const gh = (stdout: string, code = 0) => vi.fn<CommandRunner>(async () => ({ code, stdout, stderr: code ? 'boom' : '' }));

  it('accepts an open thread of a PR of this session, as the watch would list it', async () => {
    const run = gh(answer());
    const r = await liveOpenThread(T, repos, run);
    expect(r).toMatchObject({
      reply: {
        threadId: T,
        repo: 'straumur-frontend',
        prNumber: 2000,
        where: 'src/apiKeys.ts:42',
        reviewer: 'github-actions',
        url: 'https://x/c2',
      },
    });
    expect(run.mock.calls[0][1]).toContain(`threadId=${T}`);
    expect(run.mock.calls[0][2]).toBe('/wt/b');
  });

  it('refuses one on another repo or branch, resolved, answered by you last, or when gh fails', async () => {
    const err = async (stdout: string, code = 0) => ((await liveOpenThread(T, repos, gh(stdout, code))) as { error: string }).error;
    expect(await err(answer({ repo: 'kvika/other' }))).toMatch(/not a pull request of this session/);
    expect(await err(answer({ head: 'feat/someone-else' }))).toMatch(/not a pull request of this session/);
    expect(await err(answer({ resolved: true }))).toMatch(/resolved/);
    expect(await err(answer({ lastBy: 'DomagojMedo' }))).toMatch(/already yours/);
    expect(await err('', 1)).toMatch(/couldn't read the thread/);
    expect(await err(JSON.stringify({ data: { viewer: { login: 'me' }, node: null } }))).toMatch(/isn't a review thread/);
  });

  it("draftReply: work's own record first (no GitHub call); else GitHub's, saved; never for an --unsafe session", async () => {
    const id = 'sess1';
    rememberSent(id, [thread(T1)]);
    const run = gh(answer());
    const io = { unsafe: false, repos: () => repos, run };
    expect(await draftReply(id, T1, 'Known one', io)).toMatchObject({ ok: true });
    expect(run).not.toHaveBeenCalled();
    // Not in work's last check (reported: two new bot threads, and `work pr reply` refused them).
    const got = await draftReply(id, T, 'We keep http:// for local development.', io);
    expect(got).toMatchObject({
      ok: true,
      reply: { threadId: T, status: 'draft', prNumber: 2000, draft: 'We keep http:// for local development.' },
    });
    expect(listReplies(id).map((r) => r.threadId)).toContain(T);
    const unsafe = await draftReply('sess2', T, 'x', { ...io, unsafe: true, run: gh(answer()) });
    expect(unsafe).toMatchObject({ ok: false });
    expect(listReplies('sess2')).toEqual([]);
  });

  it('draftReply: answered before, and the reviewer answered since (work has yet to see it): GitHub says so, it starts over', async () => {
    withDb((d) =>
      d.prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)').run(
        'sess4',
        T,
        JSON.stringify({
          ...thread(T),
          status: 'posted',
          draft: 'Old',
          sentAt: '2026-10-27T10:00:00Z',
          postedAt: '2026-10-27T10:00:00Z',
        }),
      ),
    );
    const r = await draftReply('sess4', T, 'New answer', { unsafe: false, repos: () => repos, run: gh(answer()) });
    expect(r).toMatchObject({ ok: true, reply: { status: 'draft', draft: 'New answer' } });
    // …but not when the last word is still yours: the earlier reply stands.
    const mine = await draftReply('sess4', T, 'Again', { unsafe: false, repos: () => repos, run: gh(answer({ lastBy: 'domagojmedo' })) });
    expect(mine).toMatchObject({ ok: true }); // the draft above is a draft now, not posted
  });

  it("draftReply: GitHub's refusal is said, with that work's check didn't list it either", async () => {
    const r = await draftReply('sess3', T, 'x', { unsafe: false, repos: () => repos, run: gh(answer({ resolved: true })) });
    expect(r).toEqual({
      ok: false,
      error: "the thread is resolved on GitHub: nothing to answer (work's last check didn't list it either)",
    });
  });
});

describe('retireResolvedReplies — a draft for a thread resolved on GitHub goes (it stayed "1 reply to post" forever)', () => {
  const resolved = (map: Record<string, boolean | null>) =>
    vi.fn<CommandRunner>(async (_cmd, args) => {
      const id = args.find((a) => a.startsWith('threadId='))!.slice('threadId='.length);
      const v = map[id];
      if (v === null) return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: JSON.stringify({ data: { node: { isResolved: v } } }), stderr: '' };
    });
  const ci = (open: string[]): SessionCi =>
    ({
      checkedAt: '2026-10-28T12:00:00Z',
      repos: [{ name: 'api', pr: null, done: false, threads: open.map((t) => ({ ...thread(t), trusted: true })) }],
    }) as unknown as SessionCi;

  it('only what GitHub says is resolved, and only rows not listed open nor posted; a failed lookup keeps it', async () => {
    const id = 'r1';
    rememberSent(id, [thread(T1), thread(T2), thread('PRRT_kwDOstillopen'), thread('PRRT_kwDOghfails')]);
    saveDraft(id, T1, 'An answer to a resolved thread');
    const run = resolved({ [T1]: true, [T2]: false, PRRT_kwDOghfails: null });
    const gone = await retireResolvedReplies(id, ci(['PRRT_kwDOstillopen']), '/wt/api', run);
    expect(gone).toEqual([T1]);
    expect(
      listReplies(id)
        .map((r) => r.threadId)
        .sort(),
    ).toEqual([T2, 'PRRT_kwDOghfails', 'PRRT_kwDOstillopen'].sort());
    // Listed open: never asked about.
    expect(run.mock.calls.some((c) => c[1].includes('threadId=PRRT_kwDOstillopen'))).toBe(false);
  });

  it('a posted reply is history, never retired; no folder to ask from: nothing asked', async () => {
    const id = 'r2';
    withDb((d) =>
      d
        .prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)')
        .run(id, T1, JSON.stringify({ ...thread(T1), status: 'posted', draft: 'Done', sentAt: 'x', postedAt: 'x' })),
    );
    const run = resolved({ [T1]: true });
    expect(await retireResolvedReplies(id, ci([]), '/wt/api', run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    rememberSent(id, [thread(T2)]);
    expect(await retireResolvedReplies(id, ci([]), null, run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
