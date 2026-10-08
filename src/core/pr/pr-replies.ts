import { json, tx, withDb } from '../platform/db.js';
import type { PrReply, SessionCi } from '../api-types.js';
import type { CommandRunner } from './ship.js';
import { sessionIdFor } from '../sessions/session-id.js';

/**
 * Replies to PR review threads, drafted by the session's Claude and posted
 * with your yes. The PR watch records each thread it hands over
 * (`rememberSent`); Claude drafts an answer with `work pr reply <thread id>
 * "<text>"` (`saveDraft`) and shows you; the dashboard shows the drafts too,
 * editable. What appears on GitHub is in your name, so a draft goes out
 * only once you've said yes: your Post click, or Claude running `work pr
 * post` after you agreed in the conversation (`postDrafts`; never on the
 * assistant's allow list, so Claude Code asks you as well).
 *
 * Rows live in state.db `pr_replies`, keyed by session + thread, and go
 * with the session (purgeSessionRows).
 */

/** GitHub review-thread node ids. Checked before a thread id reaches gh or the database. */
export const THREAD_ID = /^PRRT_[A-Za-z0-9_-]{4,120}$/;
export const MAX_REPLY_CHARS = 20_000;

function parseRow(data: string): PrReply | null {
  const v = json.parse(data);
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const str = (k: string) => typeof r[k] === 'string';
  if (
    !str('threadId') ||
    !str('repo') ||
    typeof r.prNumber !== 'number' ||
    !str('url') ||
    !str('reviewer') ||
    !str('excerpt') ||
    !str('sentAt')
  )
    return null;
  if (r.status !== 'sent' && r.status !== 'draft' && r.status !== 'posted') return null;
  return v as PrReply;
}

function read(sessionId: string, threadId: string): PrReply | null {
  const row = withDb(
    (d) =>
      d.prepare('SELECT data FROM pr_replies WHERE session_id = ? AND thread_id = ?').get(sessionId, threadId) as
        { data: string } | undefined,
  );
  return row ? parseRow(row.data) : null;
}

export function listReplies(sessionId: string): PrReply[] {
  const rows = withDb((d) => d.prepare('SELECT data FROM pr_replies WHERE session_id = ?').all(sessionId) as Array<{ data: string }>);
  return rows
    .map((r) => parseRow(r.data))
    .filter((r): r is PrReply => r !== null)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

/** Drafts waiting for you, per session (one query for the whole session list). */
export function draftCounts(): Map<string, number> {
  const rows = withDb((d) => d.prepare('SELECT session_id, data FROM pr_replies').all() as Array<{ session_id: string; data: string }>);
  const out = new Map<string, number>();
  for (const r of rows) if (parseRow(r.data)?.status === 'draft') out.set(r.session_id, (out.get(r.session_id) ?? 0) + 1);
  return out;
}

/**
 * The threads just handed to the session's Claude. A thread seen again —
 * a reviewer answered in it — starts over: the old draft answered
 * something else.
 */
export function rememberSent(
  sessionId: string,
  threads: Array<Pick<PrReply, 'threadId' | 'repo' | 'prNumber' | 'url' | 'where' | 'reviewer' | 'excerpt'>>,
  now = new Date(),
): void {
  tx((d) => {
    const put = d.prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)');
    for (const t of threads) {
      if (!THREAD_ID.test(t.threadId)) continue;
      const row: PrReply = { ...t, status: 'sent', draft: null, sentAt: now.toISOString() };
      put.run(sessionId, t.threadId, JSON.stringify(row));
    }
  });
}

export type DraftResult = { ok: true; reply: PrReply } | { ok: false; error: string };

/** Claude's (or your edited) answer to a thread it was handed. */
export function saveDraft(sessionId: string, threadId: string, body: string, now = new Date()): DraftResult {
  if (!THREAD_ID.test(threadId)) return { ok: false, error: `not a review thread id: ${threadId}` };
  const text = body.trim();
  if (!text) return { ok: false, error: 'the reply is empty' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, error: `the reply is over ${MAX_REPLY_CHARS} characters` };
  return tx((d) => {
    const row = d.prepare('SELECT data FROM pr_replies WHERE session_id = ? AND thread_id = ?').get(sessionId, threadId) as
      { data: string } | undefined;
    const cur = row ? parseRow(row.data) : null;
    if (!cur)
      return {
        ok: false,
        error: `thread ${threadId} wasn't handed to this session (only threads from its PR feedback notes can be answered)`,
      } as const;
    if (cur.status === 'posted') return { ok: false, error: 'a reply to this thread was already posted' } as const;
    const next: PrReply = { ...cur, status: 'draft', draft: text, draftedAt: now.toISOString() };
    d.prepare('UPDATE pr_replies SET data = ? WHERE session_id = ? AND thread_id = ?').run(JSON.stringify(next), sessionId, threadId);
    return { ok: true, reply: next } as const;
  });
}

export function discardReply(sessionId: string, threadId: string): boolean {
  return withDb((d) => d.prepare('DELETE FROM pr_replies WHERE session_id = ? AND thread_id = ?').run(sessionId, threadId).changes > 0);
}

function markPosted(sessionId: string, threadId: string, body: string, postedUrl: string, resolved: boolean): void {
  tx((d) => {
    const row = d.prepare('SELECT data FROM pr_replies WHERE session_id = ? AND thread_id = ?').get(sessionId, threadId) as
      { data: string } | undefined;
    const cur = row ? parseRow(row.data) : null;
    if (!cur) return;
    const next: PrReply = { ...cur, status: 'posted', draft: body, postedAt: new Date().toISOString(), postedUrl, resolved };
    d.prepare('UPDATE pr_replies SET data = ? WHERE session_id = ? AND thread_id = ?').run(JSON.stringify(next), sessionId, threadId);
  });
}

const ADD_REPLY = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { url } }
}`;
const RESOLVE = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }`;
/** The thread as it is now, and who you are: the last check before a reply goes out. */
const THREAD_NOW = `query($threadId: ID!) {
  viewer { login }
  node(id: $threadId) { ... on PullRequestReviewThread { isResolved comments(last: 1) { nodes { author { login } } } } }
}`;

/**
 * Why a reply mustn't go out now, from the thread as GitHub has it: the last
 * word in it is already yours (you'd be answering yourself — a PR author's
 * own comment, handed over as if a reviewer's), or it was resolved since.
 * Null to go ahead. When gh can't say, it isn't posted (it'd be in your name). Exported for tests.
 */
export async function threadRefusal(threadId: string, cwd: string, run: CommandRunner): Promise<string | null> {
  const r = await run('gh', ['api', 'graphql', '-f', `query=${THREAD_NOW}`, '-f', `threadId=${threadId}`], cwd);
  if (r.code !== 0) return `couldn't read the thread on GitHub first: ${r.stderr.trim() || 'gh failed'}`;
  const j = json.parse(r.stdout) as {
    data?: {
      viewer?: { login?: unknown };
      node?: { isResolved?: unknown; comments?: { nodes?: Array<{ author?: { login?: unknown } | null } | null> } } | null;
    };
  } | null;
  const me = j?.data?.viewer?.login;
  const node = j?.data?.node;
  if (typeof me !== 'string' || !me || !node) return "couldn't read the thread on GitHub first";
  if (node.isResolved === true) return 'the thread was resolved on GitHub since: nothing to answer';
  const last = node.comments?.nodes?.at(-1)?.author?.login;
  if (typeof last === 'string' && last.toLowerCase() === me.toLowerCase())
    return 'the last word in this thread is already yours (@' + me + '): a reply would answer yourself';
  return null;
}

export type PostResult = { ok: true; url: string; resolved: boolean } | { ok: false; error: string };

/**
 * Post the reply from your GitHub account (gh), then resolve the thread if
 * asked. Run on your yes: the Post route (a POST behind the local-origin
 * guard) or `work pr post`. It re-reads the row first.
 */
export async function postReply(
  sessionId: string,
  threadId: string,
  body: string,
  opts: { resolve: boolean; cwd: string; run: CommandRunner },
): Promise<PostResult> {
  if (!THREAD_ID.test(threadId)) return { ok: false, error: 'not a review thread id' };
  const text = body.trim();
  if (!text || text.length > MAX_REPLY_CHARS) return { ok: false, error: 'the reply is empty or too long' };
  const cur = read(sessionId, threadId);
  if (!cur) return { ok: false, error: 'no such thread for this session' };
  if (cur.status === 'posted') return { ok: false, error: 'already posted' };
  // Whatever handed it over, a reply never answers your own last word (reported: a PR author's
  // Claude answered his own comment, as if a reviewer's), nor a thread resolved meanwhile.
  const refusal = await threadRefusal(threadId, opts.cwd, opts.run);
  if (refusal) return { ok: false, error: refusal };
  // -f: raw strings (never @file / number parsing), argv only (no shell).
  const add = await opts.run(
    'gh',
    ['api', 'graphql', '-f', `query=${ADD_REPLY}`, '-f', `threadId=${threadId}`, '-f', `body=${text}`],
    opts.cwd,
  );
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || 'gh could not post the reply' };
  let url = cur.url;
  const parsed = json.parse(add.stdout) as { data?: { addPullRequestReviewThreadReply?: { comment?: { url?: unknown } } } } | null;
  const got = parsed?.data?.addPullRequestReviewThreadReply?.comment?.url;
  if (typeof got === 'string') url = got;
  let resolved = false;
  if (opts.resolve) {
    const r = await opts.run('gh', ['api', 'graphql', '-f', `query=${RESOLVE}`, '-f', `threadId=${threadId}`], opts.cwd);
    resolved = r.code === 0;
  }
  markPosted(sessionId, threadId, text, url, resolved);
  return { ok: true, url, resolved };
}

/**
 * Post saved drafts as they stand (your edits in the dashboard included):
 * `work pr post`, which a session's Claude runs once you've said yes to
 * them in the conversation. One at a time, each re-checked by postReply.
 */
export async function postDrafts(
  session: { target: string; branch: string; paths: string[] },
  drafts: PrReply[],
  resolve: boolean,
  run: CommandRunner,
): Promise<{ posted: Array<PrReply & { url: string; resolved: boolean }>; failed: Array<{ threadId: string; error: string }> }> {
  const id = sessionIdFor(session);
  const cwd = session.paths.find((p) => p) ?? process.cwd();
  const posted: Array<PrReply & { url: string; resolved: boolean }> = [];
  const failed: Array<{ threadId: string; error: string }> = [];
  for (const d of drafts) {
    const r = await postReply(id, d.threadId, d.draft ?? '', { resolve, cwd, run });
    if (r.ok) posted.push({ ...d, url: r.url, resolved: r.resolved });
    else failed.push({ threadId: d.threadId, error: r.error });
  }
  return { posted, failed };
}

/**
 * The replies posted after the PR watch last read GitHub (`checkedAt`): the
 * threads they answer still look unanswered in its check. Pure.
 */
export function postedSince(replies: PrReply[], checkedAt: string | null | undefined): string[] {
  const since = checkedAt ? Date.parse(checkedAt) : 0;
  return replies.filter((r) => r.status === 'posted' && r.postedAt && Date.parse(r.postedAt) > since).map((r) => r.threadId);
}

/**
 * A reply went out (your Post, or `work pr post` from the session's
 * Claude): take the threads it answered out of the PR watch's last check,
 * so the session stops saying a thread waits on you before the watch reads
 * GitHub again. Read from what was posted, not from the request.
 */
export function markPostedAnswered(
  sessionId: string,
  watch: { state(id: string): SessionCi | null; answered(id: string, threadId: string): void },
): string[] {
  const threads = postedSince(listReplies(sessionId), watch.state(sessionId)?.checkedAt);
  for (const t of threads) watch.answered(sessionId, t);
  return threads;
}
