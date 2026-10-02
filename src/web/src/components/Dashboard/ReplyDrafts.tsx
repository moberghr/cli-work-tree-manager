import { useCallback, useEffect, useState } from 'react';
import type { OpenReviewThread, PrReply, RepliesWire } from '../../../../core/api-types.js';
import { discardReply, editReply, fetchReplies, postReply, sendPromptToSession } from '../../api/client.js';
import { useSse } from '../../api/events.js';

export interface ReplyApi {
  list: (sessionId: string) => Promise<RepliesWire>;
  /** Send its Claude a note (a published comment), for "Ask Claude to reply". */
  ask: (sessionId: string, body: string) => Promise<void>;
  edit: (sessionId: string, threadId: string, body: string) => Promise<unknown>;
  discard: (sessionId: string, threadId: string) => Promise<unknown>;
  post: (sessionId: string, threadId: string, body: string, resolve: boolean) => Promise<{ url: string; resolved: boolean }>;
}

const httpReplies: ReplyApi = { list: fetchReplies, edit: editReply, discard: discardReply, post: postReply, ask: sendPromptToSession };

/** The note "Ask Claude to reply" sends: draft it (never post it) — the same flow as the PR watch's. */
export function askToReplyPrompt(t: OpenReviewThread): string {
  return [
    `Review thread [thread ${t.threadId}] on PR #${t.prNumber}${t.where ? ` (${t.where})` : ''}, from @${t.reviewer}, has no reply yet:`,
    '',
    `> ${t.excerpt.replace(/\n/g, ' ')}`,
    '',
    `Fix it if it's right, then draft an answer with \`work pr reply ${t.threadId} "…"\` and show it to me. Don't post it.`,
  ].join('\n');
}

/**
 * Replies to the PR's review threads, drafted by the session's Claude, for
 * you to post: each shows the reviewer's comment, the draft (editable), and
 * Post & resolve / Post / Discard. Open threads with no draft are listed
 * too (the comment, a link, Ask Claude to reply), so a "1 unresolved" count
 * is never all you see. Nothing reaches GitHub until you click Post.
 */
export function ReplyDrafts({ sessionId, api = httpReplies }: { sessionId: string; api?: ReplyApi }) {
  const [replies, setReplies] = useState<PrReply[]>([]);
  const [waiting, setWaiting] = useState<OpenReviewThread[]>([]);
  const load = useCallback(() => {
    api.list(sessionId).then(
      (r) => {
        setReplies(r.replies);
        setWaiting(r.waiting);
      },
      () => {},
    );
  }, [api, sessionId]);
  useEffect(() => {
    setReplies([]);
    setWaiting([]);
    load();
  }, [load]);
  useSse('/events', {
    events: {
      'replies-changed': (d) => {
        if ((d as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });
  const drafts = replies.filter((r) => r.status === 'draft');
  if (drafts.length === 0 && waiting.length === 0) return null;
  return (
    <section className="wd-replies" aria-label="Replies to review threads">
      {drafts.length > 0 && (
        <h3 className="wd-replies-title">
          ✍ {drafts.length} {drafts.length === 1 ? 'reply' : 'replies'} to post
        </h3>
      )}
      {drafts.map((r) => (
        <Draft key={r.threadId} reply={r} sessionId={sessionId} api={api} onDone={load} />
      ))}
      {waiting.length > 0 && (
        <h3 className="wd-replies-title">
          💬 {waiting.length} unresolved review thread{waiting.length === 1 ? '' : 's'} with no reply yet
        </h3>
      )}
      {waiting.map((t) => (
        <Waiting key={t.threadId} thread={t} sessionId={sessionId} api={api} handed={replies.some((r) => r.threadId === t.threadId && r.status === 'sent')} />
      ))}
    </section>
  );
}

/** An open thread with nothing drafted: what was said, where, and a way on. */
function Waiting({ thread, sessionId, api, handed }: { thread: OpenReviewThread; sessionId: string; api: ReplyApi; handed: boolean }) {
  const [state, setState] = useState<'idle' | 'asking' | 'asked'>('idle');
  const [error, setError] = useState<string | null>(null);
  const ask = () => {
    setState('asking');
    setError(null);
    api.ask(sessionId, askToReplyPrompt(thread)).then(
      () => setState('asked'),
      (e: Error) => {
        setError(e.message);
        setState('idle');
      },
    );
  };
  return (
    <article className="wd-reply">
      <div className="wd-reply-head">
        <a href={thread.url} target="_blank" rel="noreferrer" className="wd-reply-where" title="Open the thread on GitHub">
          PR #{thread.prNumber}
          {thread.where ? ` · ${thread.where}` : ''}
        </a>
        <span className="wd-replies-muted"> @{thread.reviewer}</span>
        {handed && <span className="wd-replies-muted"> · handed to Claude, no draft yet</span>}
      </div>
      <blockquote className="wd-reply-quote">{thread.excerpt}</blockquote>
      {error && <div className="wd-tab-error" role="alert">{error}</div>}
      <div className="wd-reply-actions">
        <button type="button" className="wd-btn-secondary" disabled={state !== 'idle'} onClick={ask} title="Send its Claude a note to fix it if needed and draft a reply (it posts nothing)">
          {state === 'asking' ? 'Asking…' : state === 'asked' ? 'Asked — the draft will show here' : 'Ask Claude to reply'}
        </button>
        <a className="wd-link-button" href={thread.url} target="_blank" rel="noreferrer">
          Answer on GitHub ↗
        </a>
      </div>
    </article>
  );
}

function Draft({ reply, sessionId, api, onDone }: { reply: PrReply; sessionId: string; api: ReplyApi; onDone: () => void }) {
  const [text, setText] = useState(reply.draft ?? '');
  const [busy, setBusy] = useState<'post' | 'resolve' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(reply.draft ?? ''), [reply.draft]);
  const act = (kind: 'post' | 'resolve' | 'discard') => {
    setBusy(kind);
    setError(null);
    const p =
      kind === 'discard'
        ? api.discard(sessionId, reply.threadId)
        : (text !== reply.draft ? api.edit(sessionId, reply.threadId, text) : Promise.resolve()).then(() =>
            api.post(sessionId, reply.threadId, text, kind === 'resolve'),
          );
    p.then(onDone, (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  return (
    <article className="wd-reply">
      <div className="wd-reply-head">
        <a href={reply.url} target="_blank" rel="noreferrer" className="wd-reply-where" title="Open the thread on GitHub">
          PR #{reply.prNumber}
          {reply.where ? ` · ${reply.where}` : ''}
        </a>
        <span className="wd-replies-muted"> @{reply.reviewer}</span>
      </div>
      <blockquote className="wd-reply-quote">{reply.excerpt}</blockquote>
      <textarea
        className="wd-reply-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(8, Math.max(2, text.split('\n').length + 1))}
        aria-label={`Reply to ${reply.reviewer}`}
      />
      {error && <div className="wd-tab-error" role="alert">{error}</div>}
      <div className="wd-reply-actions">
        <button type="button" className="wd-btn-primary" disabled={!!busy || !text.trim()} onClick={() => act('resolve')} title="Post from your GitHub account, then resolve the thread">
          {busy === 'resolve' ? 'Posting…' : 'Post & resolve'}
        </button>
        <button type="button" className="wd-btn-secondary" disabled={!!busy || !text.trim()} onClick={() => act('post')} title="Post from your GitHub account; leave the thread open">
          {busy === 'post' ? 'Posting…' : 'Post'}
        </button>
        <button type="button" className="wd-link-button" disabled={!!busy} onClick={() => act('discard')} title="Drop the draft; nothing is posted">
          {busy === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
      </div>
    </article>
  );
}
