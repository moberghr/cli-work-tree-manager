import { json, tx, withDb, type Db } from '../platform/db.js';
import type { PrReply, SessionCi, ThreadCode } from '../api-types.js';
import { isThreadCode, MAX_THREAD_BODY, threadCode } from './pr-review.js';
import type { CommandRunner } from './ship.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { isSessionCi } from './pr-watch-store.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionRepos } from '../sessions/session-repos.js';
import { loadConfig } from '../platform/config.js';
import { readGitConfig, originUrl } from '../worktree/repo-scan.js';
import { defaultHost, hostForOrigin, hostOfThread, knownHosts } from '../hosts/index.js';
import type { GitHost } from '../hosts/types.js';
import { GITHUB_THREAD_ID } from '../hosts/github/threads.js';
import { checkedOutBranch } from '../git/git-head.js';

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
 * with the session (purgeSessionRows). A thread the PR watch lists as open
 * for the session (its last check, `pr_watch_state`) can be drafted too:
 * "Ask Claude to reply" hands one over as a plain note, with no row here.
 */

/** A review-thread id of some host work knows (each host's own shape). Checked before an id reaches a CLI or the database. */
export function isThreadId(id: string): boolean {
  return knownHosts().some((h) => h.threads.isId(id));
}
/** GitHub's thread ids (`PRRT_…`). Kept for callers from before hosts: `isThreadId` takes every host's. */
export const THREAD_ID = GITHUB_THREAD_ID;
/** The host a thread id belongs to (GitHub's when none reads it: such an id was refused before reaching here). */
const threadHost = (id: string): GitHost => hostOfThread(id) ?? defaultHost();
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
  // What's only shown (the whole comment, its code): a malformed one is dropped, the row kept.
  const row = v as PrReply;
  if (row.body !== undefined && typeof row.body !== 'string') delete row.body;
  if (row.code !== undefined && !isThreadCode(row.code)) delete row.code;
  return row;
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
  threads: Array<Pick<PrReply, 'threadId' | 'repo' | 'prNumber' | 'url' | 'where' | 'reviewer' | 'excerpt' | 'body' | 'code'>>,
  now = new Date(),
): void {
  tx((d) => {
    const put = d.prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)');
    for (const t of threads) {
      if (!isThreadId(t.threadId)) continue;
      const row: PrReply = { ...t, status: 'sent', draft: null, sentAt: now.toISOString() };
      put.run(sessionId, t.threadId, JSON.stringify(row));
    }
  });
}

export type DraftResult = { ok: true; reply: PrReply } | { ok: false; error: string };

/**
 * The thread as the PR watch's last check of the session lists it, open (as of `checkedAt`): a reply's row is
 * made from it, never from what the drafter typed.
 */
function openThreadOf(d: Db, sessionId: string, threadId: string, now: Date): { reply: PrReply; checkedAt: string } | null {
  const row = d.prepare('SELECT data FROM pr_watch_state WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
  const ci = row ? json.parse(row.data) : null;
  if (!isSessionCi(ci)) return null;
  for (const r of ci.repos) {
    const t = r.threads?.find((x) => x.threadId === threadId);
    if (!t) continue;
    const { repo, prNumber, url, where, reviewer, excerpt, body, code } = t;
    const reply: PrReply = {
      threadId,
      repo,
      prNumber,
      url,
      where,
      reviewer,
      excerpt,
      ...(body !== undefined ? { body } : {}),
      ...(code ? { code } : {}),
      status: 'sent',
      draft: null,
      sentAt: now.toISOString(),
    };
    return { reply, checkedAt: ci.checkedAt };
  }
  return null;
}

/**
 * Claude's (or your edited) answer to a thread it was handed, or one the PR watch lists as open for the session.
 * A thread answered before and listed open again since (the reviewer answered) starts over, as `rememberSent` does.
 * A session launched `--unsafe` (`opts.unsafe`) drafts only what the watch handed it: review text never reaches it.
 */
export function saveDraft(
  sessionId: string,
  threadId: string,
  body: string,
  now = new Date(),
  opts: { unsafe?: boolean; live?: PrReply } = {},
): DraftResult {
  if (!isThreadId(threadId)) return { ok: false, error: `not a review thread id: ${threadId}` };
  const text = body.trim();
  if (!text) return { ok: false, error: 'the reply is empty' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, error: `the reply is over ${MAX_REPLY_CHARS} characters` };
  return tx((d) => {
    const row = d.prepare('SELECT data FROM pr_replies WHERE session_id = ? AND thread_id = ?').get(sessionId, threadId) as
      { data: string } | undefined;
    const handed = row ? parseRow(row.data) : null;
    const listed = opts.unsafe ? null : openThreadOf(d, sessionId, threadId, now);
    const raisedAgain =
      handed?.status === 'posted' && listed && Date.parse(listed.checkedAt) > Date.parse(handed.postedAt ?? '') ? listed.reply : null;
    // `live`: read from GitHub just now (draftReply), when work's last check hadn't it.
    const cur = raisedAgain ?? (handed?.status === 'posted' && opts.live ? opts.live : (handed ?? listed?.reply ?? opts.live ?? null));
    if (!cur)
      return {
        ok: false,
        error: `thread ${threadId} isn't an open review thread of this session's pull requests (as work last checked them)`,
      } as const;
    if (cur.status === 'posted') return { ok: false, error: 'a reply to this thread was already posted' } as const;
    const next: PrReply = { ...cur, status: 'draft', draft: text, draftedAt: now.toISOString() };
    d.prepare('INSERT OR REPLACE INTO pr_replies (session_id, thread_id, data) VALUES (?, ?, ?)').run(
      sessionId,
      threadId,
      JSON.stringify(next),
    );
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

/**
 * Why a reply mustn't go out now, from the thread as GitHub has it: the last
 * word in it is already yours (you'd be answering yourself — a PR author's
 * own comment, handed over as if a reviewer's), or it was resolved since.
 * Null to go ahead. When gh can't say, it isn't posted (it'd be in your name). Exported for tests.
 */
export async function threadRefusal(threadId: string, cwd: string, run: CommandRunner): Promise<string | null> {
  const host = threadHost(threadId);
  const r = await host.threads.now(run, cwd, threadId);
  if (!r.ok) return r.error;
  const { viewer: me, resolved, lastAuthor } = r.thread;
  if (resolved) return `the thread was resolved on ${host.name} since: nothing to answer`;
  if (lastAuthor && lastAuthor.toLowerCase() === me.toLowerCase())
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
  if (!isThreadId(threadId)) return { ok: false, error: 'not a review thread id' };
  const text = body.trim();
  if (!text || text.length > MAX_REPLY_CHARS) return { ok: false, error: 'the reply is empty or too long' };
  const cur = read(sessionId, threadId);
  if (!cur) return { ok: false, error: 'no such thread for this session' };
  if (cur.status === 'posted') return { ok: false, error: 'already posted' };
  // Whatever handed it over, a reply never answers your own last word (reported: a PR author's
  // Claude answered his own comment, as if a reviewer's), nor a thread resolved meanwhile.
  const refusal = await threadRefusal(threadId, opts.cwd, opts.run);
  if (refusal) return { ok: false, error: refusal };
  const host = threadHost(threadId);
  const add = await host.threads.reply(opts.run, opts.cwd, threadId, text);
  if (!add.ok) return { ok: false, error: add.error };
  const url = add.url ?? cur.url;
  let resolved = false;
  if (opts.resolve) resolved = await host.threads.resolve(opts.run, opts.cwd, threadId);
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

/** The session's repos with what the live lookup matches a thread against: their GitHub name and checked-out branch. */
export function sessionRepoRefs(s: WorktreeSession): SessionRepoRef[] {
  return sessionRepos(s, loadConfig()).map((r) => {
    const config = readGitConfig(r.path);
    const origin = config ? originUrl(config) : null;
    const host = hostForOrigin(origin);
    return { name: r.alias, path: r.path, github: origin ? host.repoId(origin) : null, host: host.id, branch: checkedOutBranch(r.path) };
  });
}

/** One of the session's repos, as the live lookup matches a thread's pull request against it. */
export interface SessionRepoRef {
  /** Its alias (what the PR watch names the repo by). */
  name: string;
  path: string;
  /** Its id on its host (GitHub: owner/name, lower case); null when its host can't tell. The name is from before hosts. */
  github: string | null;
  /** The host it's on (absent: GitHub, as before hosts). */
  host?: string;
  /** The branch checked out there now. */
  branch: string | null;
}

/**
 * The thread read from GitHub now, accepted as the PR watch would list it:
 * on an open pull request of this session (its repo, from the branch one of
 * the session's checkouts has), not resolved, and its last word not yours.
 * What `work pr reply` falls back to when work's last check hasn't the
 * thread — a new one since, or a watch that missed the session — so a
 * reply is never stuck on stale state, and never looser than the watch.
 */
export async function liveOpenThread(
  threadId: string,
  repos: SessionRepoRef[],
  run: CommandRunner,
  now = new Date(),
): Promise<{ reply: PrReply } | { error: string }> {
  if (!isThreadId(threadId)) return { error: `not a review thread id: ${threadId}` };
  const host = threadHost(threadId);
  // A repo of the session on that host to ask from (any folder does for GitHub's global ids).
  const cwd = (repos.find((x) => (x.host ?? 'github') === host.id) ?? repos[0])?.path;
  if (!cwd) return { error: `the session has no repo to ask ${host.name} from` };
  const r = await host.threads.live(run, cwd, threadId);
  if (!r.ok) return { error: r.error };
  const t = r.thread;
  const me = t.viewer;
  const repo = repos.find(
    (x) => (x.host ?? 'github') === host.id && x.github === t.pr.repoId && !!x.branch && x.branch === t.pr.headBranch,
  );
  if (!repo) return { error: `${threadId} is on ${t.pr.repoId || 'a repo'} #${t.pr.number}, not a pull request of this session` };
  if (t.resolved) return { error: `the thread is resolved on ${host.name}: nothing to answer` };
  const lastBy = t.last?.author ?? '';
  if (lastBy.toLowerCase() === me.toLowerCase()) return { error: `the last word in this thread is already yours (@${me})` };
  const path = t.path ?? '';
  const body = t.first?.body ?? '';
  return {
    reply: {
      threadId,
      repo: repo.name,
      prNumber: t.pr.number,
      url: t.last?.url || t.pr.url,
      where: path ? `${path}${typeof t.line === 'number' ? `:${t.line}` : ''}` : null,
      reviewer: t.first?.author ?? '',
      excerpt: body.slice(0, 400),
      body: body.slice(0, MAX_THREAD_BODY),
      ...withCode(threadCode(t.first?.diffHunk, t.originalStartLine, t.originalLine, t.outdated)),
      status: 'sent',
      draft: null,
      sentAt: now.toISOString(),
    },
  };
}

const withCode = (code: ThreadCode | null): { code?: ThreadCode } => (code ? { code } : {});

/**
 * Reply rows from before they carried the whole comment and its code: those
 * filled in from the PR watch's open threads (same thread id), for the PR tab.
 * Nothing is written. Pure.
 */
export function withThreadContext(
  replies: PrReply[],
  open: ReadonlyArray<{ threadId: string; body?: string; code?: ThreadCode }>,
): PrReply[] {
  const byId = new Map(open.map((t) => [t.threadId, t]));
  return replies.map((r) => {
    const t = byId.get(r.threadId);
    if (!t || (r.body !== undefined && r.code)) return r;
    return {
      ...r,
      ...(r.body === undefined && t.body !== undefined ? { body: t.body } : {}),
      ...(!r.code && t.code ? { code: t.code } : {}),
    };
  });
}

/** What `saveDraft` refuses that GitHub may know better: a thread it can't find, or one answered before
 *  that the reviewer may have answered since (work's last check not having seen it yet). */
const ASK_GITHUB = /isn't an open review thread of this session|already posted/;

/**
 * Draft a reply — what `work pr reply` and the dashboard's PUT do: from
 * what work knows (`saveDraft`), else from the thread as GitHub has it now
 * (`liveOpenThread`), never for a session launched `--unsafe` (it drafts
 * only what the watch handed it).
 */
export async function draftReply(
  sessionId: string,
  threadId: string,
  body: string,
  io: { unsafe: boolean; repos: () => SessionRepoRef[]; run: CommandRunner },
  now = new Date(),
): Promise<DraftResult> {
  const known = saveDraft(sessionId, threadId, body, now, { unsafe: io.unsafe });
  if (known.ok || io.unsafe || !ASK_GITHUB.test(known.error)) return known;
  const live = await liveOpenThread(threadId, io.repos(), io.run, now);
  if ('error' in live) return { ok: false, error: `${live.error} (work's last check didn't list it either)` };
  return saveDraft(sessionId, threadId, body, now, { live: live.reply });
}

/** At most this many threads looked up per check: a session with many old rows catches up over a few. */
const RETIRE_PER_CHECK = 10;

/**
 * Reply rows of the session — handed over, or drafted and not posted —
 * whose thread the PR watch's check doesn't list as open, asked about on
 * GitHub one by one: those it says are resolved are discarded (nothing to
 * answer; Post could only refuse, and "1 reply to post" stayed forever).
 * Never from absence alone: a failed lookup leaves a thread off the list
 * too, so only GitHub's own "resolved" retires one. Returns the thread ids
 * that went.
 */
export async function retireResolvedReplies(sessionId: string, ci: SessionCi, cwd: string | null, run: CommandRunner): Promise<string[]> {
  if (!cwd) return [];
  const open = new Set(ci.repos.flatMap((r) => (r.threads ?? []).map((t) => t.threadId)));
  const suspects = listReplies(sessionId)
    .filter((r) => r.status !== 'posted' && !open.has(r.threadId))
    .slice(0, RETIRE_PER_CHECK);
  const gone: string[] = [];
  for (const r of suspects) {
    if ((await threadHost(r.threadId).threads.isResolved(run, cwd, r.threadId)) !== true) continue;
    if (discardReply(sessionId, r.threadId)) gone.push(r.threadId);
  }
  return gone;
}
