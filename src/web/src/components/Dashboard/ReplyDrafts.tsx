import { useCallback, useEffect, useState } from 'react';
import type { PrReply } from '../../../../core/api-types.js';
import { discardReply, editReply, fetchReplies, postReply } from '../../api/client.js';
import { useSse } from '../../api/events.js';

export interface ReplyApi {
  list: (sessionId: string) => Promise<PrReply[]>;
  edit: (sessionId: string, threadId: string, body: string) => Promise<unknown>;
  discard: (sessionId: string, threadId: string) => Promise<unknown>;
  post: (sessionId: string, threadId: string, body: string, resolve: boolean) => Promise<{ url: string; resolved: boolean }>;
}

const httpReplies: ReplyApi = { list: fetchReplies, edit: editReply, discard: discardReply, post: postReply };

/**
 * Replies to the PR's review threads, drafted by the session's Claude, for
 * you to post: each shows the reviewer's comment, the draft (editable), and
 * Post & resolve / Post / Discard. Threads Claude is still working on are
 * counted. Nothing reaches GitHub until you click Post.
 */
export function ReplyDrafts({ sessionId, api = httpReplies }: { sessionId: string; api?: ReplyApi }) {
  const [replies, setReplies] = useState<PrReply[]>([]);
  const load = useCallback(() => {
    api.list(sessionId).then(setReplies, () => {});
  }, [api, sessionId]);
  useEffect(() => {
    setReplies([]);
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
  const working = replies.filter((r) => r.status === 'sent').length;
  // Only when there is something to post: the status and the CI strip
  // above already say there are review threads.
  if (drafts.length === 0) return null;
  return (
    <section className="wd-replies" aria-label="Replies to review threads">
      <h3 className="wd-replies-title">
        ✍ {drafts.length} {drafts.length === 1 ? 'reply' : 'replies'} to post
        {working > 0 && <span className="wd-replies-muted"> · Claude is still on {working} more</span>}
      </h3>
      {drafts.map((r) => (
        <Draft key={r.threadId} reply={r} sessionId={sessionId} api={api} onDone={load} />
      ))}
    </section>
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
