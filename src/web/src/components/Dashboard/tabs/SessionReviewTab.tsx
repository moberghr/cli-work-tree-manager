import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrReviewWire, SessionReviewWire } from '../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../core/diff/diff-parse.js';
import {
  dismissSessionReviewNote,
  markSessionReviewSeen,
  fetchSessionReview,
  fetchSessionReviewCurrent,
  fetchSessionReviewDiff,
  prepareSessionReview,
  sendSessionReviewNotes,
  sendSessionReviewRecommendation,
  type SessionSummary,
} from '../../../api/client.js';
import { draftsAsComments } from '../../../api/review-drafts-api.js';
import type { ReviewApi } from '../../../api/review-api.js';
import { useSse } from '../../../api/events.js';
import { timeAgo } from '../../../utils/time.js';
import { ReviewProvider } from '../../../state/ReviewProvider.js';
import { HostThreadsProvider } from '../../../state/HostThreads.js';
import { commentWalk, reviewPages } from '../../../state/review-view.js';
import { sessionReviewPagePath } from '../../../state/session-review-page.js';
import { toggled } from '../../../state/review-prefs.js';
import { Input, Segmented, Select } from '../../../ui/index.js';
import { ReviewOverview } from './review/ReviewOverview.js';
import { ReviewFreshness } from './review/ReviewFreshness.js';
import { StoryPager } from './review/StoryPager.js';
import { CommentWalk } from './review/CommentWalk.js';
import { FilesView } from './review/FilesView.js';

type Mode = 'overview' | 'story' | 'comments' | 'files';

/** What the tab says above the review: where it stands and what it covers. Pure. */
export function localReviewLine(w: SessionReviewWire, now: number = Date.now()): string {
  if (w.status === 'none') return 'No review of this branch’s changes is prepared yet.';
  if (w.status === 'failed') return `Couldn’t prepare it: ${w.error ?? 'unknown reason'}`;
  const r = w.review;
  const what = r
    ? `${r.repo}: ${r.size.files} file${r.size.files === 1 ? '' : 's'}, +${r.size.added} −${r.size.deleted} since ${r.base}`
    : '';
  if (w.status === 'running')
    return r ? `Preparing it again… (showing the last one: ${what})` : 'Preparing… reading the changes takes a minute or two.';
  return `${what} · prepared ${w.at ? timeAgo(w.at, now) : 'just now'}${w.how ? ` · ${w.how}` : ''}${r?.why ? ` · ${r.why}` : ''}`;
}

/** The review with the notes you set aside taken out (they stay out until it is prepared again). Pure. */
export function withoutNotes(r: PrReviewWire, removed: ReadonlySet<string>): PrReviewWire {
  return removed.size ? { ...r, drafts: r.drafts.filter((d) => !removed.has(d.id)) } : r;
}

/** How often an open tab asks whether the changes have moved since its review was prepared. */
export const STALE_CHECK_MS = 60_000;

/** The notes not handed to the agent yet, in the walk's order. Pure. */
export function unsentNotes<T extends { id: string }>(walk: readonly T[], sent: ReadonlySet<string>): T[] {
  return walk.filter((d) => !sent.has(d.id));
}

/** What the button that sends the rest says: "Send 16 notes to Claude", then "Send the 3 remaining notes", then all sent. Pure. */
export function sendRestLabel(total: number, unsent: number): string {
  if (unsent === 0) return total === 1 ? 'The note is sent' : `All ${total} notes are sent`;
  const notes = `note${unsent === 1 ? '' : 's'}`;
  return unsent === total ? `Send ${unsent} ${notes} to Claude` : `Send the ${unsent} remaining ${notes}`;
}

/**
 * A session's Review tab: its branch's changes read as a review before there is a pull request — the Reviews tab's
 * overview, stories, comments walk and files, made of the diff since the branch's base. Prepared when you ask
 * (local changes move with every turn). Nothing goes to a host from here: the notes it raises can be handed to the
 * session's agent — all that are left, or one at a time (asked for: you may not agree with some) — and a note you
 * don't agree with is dismissed.
 */
export function SessionReviewTab({
  session,
  onShowTerminal,
  ownPage,
}: {
  session: SessionSummary;
  onShowTerminal?: () => void;
  /** It is on a page of its own (`/session-review/<id>`): no link to open one. */
  ownPage?: boolean;
}) {
  const id = session.id;
  const [data, setData] = useState<SessionReviewWire | null>(null);
  const [files, setFiles] = useState<ParsedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('overview');
  const [storyAt, setStoryAt] = useState(0);
  const [commentAt, setCommentAt] = useState(0);
  const [file, setFile] = useState<string | undefined>(undefined);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [looked, setLooked] = useState<Set<string>>(new Set());
  /** What you typed for this one review; null: not typed yet (the kept review's shows). */
  const [also, setAlso] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  /** The changes have moved since the review was prepared (asked again every minute while the tab is open). */
  const [moved, setMoved] = useState(false);

  const load = useCallback(() => {
    fetchSessionReview(id).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'session-review-changed': load } });

  const raw = data?.review ?? null;
  const signature = raw?.headSha;
  // A review of other changes is another review: its diff, and what you ticked or set aside, start over.
  useEffect(() => {
    setFiles(null);
    setViewed(new Set());
    setLooked(new Set());
    setSent(null);
    setMode('overview');
    if (!signature) return;
    fetchSessionReviewDiff(id).then(
      (d) => setFiles(d.files),
      () => setFiles([]),
    );
  }, [id, signature]);

  // Shown: you have looked at it, so it leaves the Inbox (a finished one, ready or failed; each finish once).
  const finishedAt = data && (data.status === 'ready' || data.status === 'failed') ? data.at : undefined;
  useEffect(() => {
    if (finishedAt) void markSessionReviewSeen(id);
  }, [id, finishedAt]);

  // Is it still of the changes as they are? Asked when it is shown, and every minute after: the session goes on working.
  const status = data?.status;
  useEffect(() => {
    setMoved(false);
    if (!signature || status !== 'ready') return;
    let gone = false;
    const check = () => {
      if (document.hidden) return;
      void fetchSessionReviewCurrent(id).then((current) => {
        if (!gone) setMoved(!current);
      });
    };
    check();
    const timer = setInterval(check, STALE_CHECK_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [id, signature, status]);

  // What was sent and dismissed is the server's (kept with the review, across restarts and reloads).
  const dismissedKey = (data?.dismissed ?? []).join(' ');
  const sentKey = (data?.sent ?? []).join(' ');
  const removed = useMemo(() => new Set(dismissedKey ? dismissedKey.split(' ') : []), [dismissedKey]);
  const sentIds = useMemo(() => new Set(sentKey ? sentKey.split(' ') : []), [sentKey]);
  const dismiss = useCallback(
    (noteId: string) => dismissSessionReviewNote(id, noteId).then(setData, (e: Error) => setError(e.message)),
    [id],
  );
  const r = useMemo(() => (raw ? withoutNotes(raw, removed) : null), [raw, removed]);
  const pages = useMemo(() => (r ? reviewPages(r) : []), [r]);
  const walk = useMemo(() => (r ? commentWalk(r, pages) : []), [r, pages]);
  const shown = useRef<PrReviewWire | null>(null);
  shown.current = r;
  // The notes as the diff's comment rows: Delete sets one aside; your own comments belong to the Diff tab.
  const api = useMemo<ReviewApi>(() => {
    const now = async () => (shown.current ? draftsAsComments(shown.current) : []);
    return {
      fetch: now,
      post: async () => {
        throw new Error('Add your own comments in the Diff tab: there they go to this session’s Claude.');
      },
      delete: async (draftId: string) => {
        await dismiss(draftId);
        return { comments: (await now()).filter((c) => c.id !== draftId) };
      },
      resolve: async () => ({ comments: await now() }),
      submit: async () => ({ comments: await now(), count: 0 }),
      discard: async () => ({ comments: await now(), discarded: 0 }),
      done: async () => undefined,
      ssePath: '/events',
      matchesEvent: () => false,
      draftsOnly: true,
    };
  }, [dismiss]);
  const hostThreads = useMemo(() => ({ inline: new Map() }), []);

  // What this one review should also pay attention to: what the kept one was asked, until you type.
  const alsoText = also ?? data?.also ?? '';
  const prepare = (repo?: string) => {
    setError(null);
    prepareSessionReview(id, repo, alsoText).then(setData, (e: Error) => setError(e.message));
  };
  const unsent = unsentNotes(walk, sentIds);
  /** Hand these notes to the session's agent: the ones left, or the one whose Send was clicked. */
  const send = (ids: string[]) => {
    if (!r || ids.length === 0) return;
    setSending(true);
    setError(null);
    sendSessionReviewNotes(id, ids)
      .then(
        (n) => {
          setSent(`${n} note${n === 1 ? '' : 's'} handed to its Claude.`);
          load();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setSending(false));
  };
  const noteActions = (d: { id: string }) =>
    sentIds.has(d.id) ? (
      <span className="wd-start-note" title="Handed to this session's Claude">
        sent ✓
      </span>
    ) : (
      <>
        <button
          type="button"
          className="wd-link-button"
          disabled={sending}
          onClick={() => send([d.id])}
          title="Hands this one note to this session's Claude"
        >
          Send
        </button>
        <button
          type="button"
          className="wd-link-button"
          onClick={() => void dismiss(d.id)}
          title="You don't agree with it: takes it out of this review (a review prepared again starts over)"
        >
          Dismiss
        </button>
      </>
    );

  if (!data) return <p className="wd-start-note wd-session-review-note">{error ?? 'Loading…'}</p>;
  const running = data.status === 'running';
  const archived = !!session.archivedAt;
  const storyIndex = Math.max(0, Math.min(storyAt, pages.length - 1));
  const commentIndex = Math.max(0, Math.min(commentAt, walk.length - 1));
  const go = (m: Mode, at = 0) => {
    setMode(m);
    if (m === 'story') setStoryAt(at);
    if (m === 'comments') setCommentAt(at);
  };
  const modes = [
    ['overview', 'Overview'],
    ['story', `Stories (${pages.filter((p) => p.story).length})`],
    ['comments', `Notes (${walk.length})`],
    ['files', `Files (${r?.files.length ?? 0})`],
  ] as const;

  return (
    <article className="wd-review wd-session-review">
      <header className="wd-review-header">
        <div className="wd-review-metaline">
          <p className="wd-start-note" role="status">
            {localReviewLine(data)}
          </p>
          <div className="wd-review-actions">
            {data.repos.length > 1 && (
              <Select
                aria-label="Repo to review"
                value={data.repo ?? ''}
                disabled={running}
                onChange={(e) => prepare(e.target.value || undefined)}
                title="All the session's repos with changes in one review, or one of them: picking prepares it"
              >
                <option value="">All repos</option>
                {data.repos.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
            {r && walk.length > 0 && !archived && (
              <button
                type="button"
                className="wd-btn-secondary"
                onClick={() => send(unsent.map((d) => d.id))}
                disabled={sending || unsent.length === 0}
                title="Hands the notes not sent yet to this session's Claude: it says which it agrees with, and fixes those. Send or Dismiss on a note does one at a time."
              >
                {sending ? 'Sending…' : sendRestLabel(walk.length, unsent.length)}
              </button>
            )}
            {!ownPage && (
              <a
                className="wd-btn-secondary wd-session-review-open-page"
                href={sessionReviewPagePath(id)}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this review in your browser, on a page of its own (as the Diff tab's does)"
              >
                Open in browser ↗
              </a>
            )}
            {!archived && (
              <Input
                className="wd-session-review-also"
                aria-label="For this review, also pay attention to"
                placeholder="For this review, also pay attention to…"
                title="Only this review is told it, beside the points set for every review (Settings → Reviews). Enter prepares."
                value={alsoText}
                maxLength={2000}
                disabled={running}
                onChange={(e) => setAlso(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') prepare(data.repo ?? undefined);
                }}
              />
            )}
            {!archived && (
              <button type="button" className="wd-btn-primary" onClick={() => prepare(data.repo ?? undefined)} disabled={running}>
                {running ? 'Preparing…' : r ? 'Prepare again' : 'Prepare the review'}
              </button>
            )}
          </div>
        </div>
        {removed.size > 0 && (
          <p className="wd-start-note" role="status">
            {removed.size} dismissed.{' '}
            <button
              type="button"
              className="wd-link-button"
              onClick={() =>
                void Promise.all([...removed].map((noteId) => dismissSessionReviewNote(id, noteId, true))).then(load, (e: Error) =>
                  setError(e.message),
                )
              }
              title="Puts the notes you dismissed back in this review"
            >
              Bring {removed.size === 1 ? 'it' : 'them'} back
            </button>
          </p>
        )}
        <ReviewFreshness
          status={data.status}
          {...(data.at ? { at: data.at } : {})}
          {...(r ? { preparedAt: r.preparedAt ?? r.at } : {})}
          why={data.error ?? null}
        />
        {moved && !running && (
          <p className="wd-start-note wd-session-review-moved" role="status">
            The changes have moved since this was prepared: a note may be about code that is different now. <strong>Prepare again</strong>{' '}
            reads them as they are.
          </p>
        )}
        {error && <p className="wd-tab-error">{error}</p>}
        {sent && (
          <p className="wd-start-note">
            {sent}{' '}
            {onShowTerminal && (
              <button type="button" className="wd-link-button" onClick={onShowTerminal}>
                Open its terminal →
              </button>
            )}
          </p>
        )}
        {r && (
          <div className="wd-review-modes">
            <Segmented
              kind="tabs"
              label="Read the review"
              value={mode}
              onChange={(m) => go(m, m === 'story' ? storyIndex : m === 'comments' ? commentIndex : 0)}
              options={modes.map(([m, label]) => ({ value: m, label }))}
            />
          </div>
        )}
      </header>

      {!r && (
        <p className="wd-start-note wd-review-not-prepared">
          It reads everything this branch changed since its base — committed or not — and groups it into stories, ranked by risk, with the
          tests each has and what no test touches. Nothing is posted anywhere: it is for you, before you open a pull request.
        </p>
      )}
      {r && (
        <ReviewProvider key={`${signature}:${removed.size}`} api={api}>
          <HostThreadsProvider value={hostThreads}>
            <div className={`wd-review-mode-body${running ? ' wd-review-stale' : ''}`} inert={running}>
              {mode === 'overview' && (
                <ReviewOverview
                  review={r}
                  pages={pages}
                  walk={walk}
                  looked={looked}
                  onLooked={(draftId, on) => setLooked((v) => toggled(v, draftId, on))}
                  onStory={(p) => go('story', p)}
                  onComment={(i) => go('comments', i)}
                  onClearDropped={() => undefined}
                  onFiles={() => go('files')}
                  {...(archived
                    ? {}
                    : { noteActions, onDecide: (decision: string) => sendSessionReviewRecommendation(id, decision).then(() => undefined) })}
                />
              )}
              {mode === 'story' && (
                <StoryPager
                  review={r}
                  pages={pages}
                  at={storyIndex}
                  files={files}
                  viewed={viewed}
                  onViewed={(path, on) => setViewed((v) => toggled(v, path, on))}
                  onGo={(p) => go('story', p)}
                  onOverview={() => go('overview')}
                />
              )}
              {mode === 'comments' && (
                <CommentWalk
                  review={r}
                  walk={walk}
                  at={commentIndex}
                  pages={pages}
                  files={files}
                  looked={looked}
                  onLooked={(draftId, on) => setLooked((v) => toggled(v, draftId, on))}
                  onGo={(i) => go('comments', i)}
                  onStory={(p) => go('story', p)}
                  onClearDropped={() => undefined}
                  {...(archived ? {} : { noteActions })}
                />
              )}
              {mode === 'files' && (
                <FilesView
                  review={r}
                  files={files}
                  viewed={viewed}
                  onViewed={(path, on) => setViewed((v) => toggled(v, path, on))}
                  {...(file ? { file } : {})}
                  onFile={(path) => setFile(path)}
                  aside={[]}
                />
              )}
            </div>
          </HostThreadsProvider>
        </ReviewProvider>
      )}
    </article>
  );
}
