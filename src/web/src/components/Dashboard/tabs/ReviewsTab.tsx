import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrReviewWire, ReviewEvent, ReviewMode, ReviewSettingsWire, ReviewsWire } from '../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../core/diff/diff-parse.js';
import { hostName } from '../../../../../core/hosts/commands.js';
import {
  clearReviewDropped,
  fetchReview,
  fetchReviewDiff,
  fetchReviews,
  fetchReviewSettings,
  prepareReview,
  refreshReviewDiscussion,
  ReviewSubmitError,
  saveReviewMode,
  settleReviewInDoubt,
  submitReview,
} from '../../../api/panes.js';
import { isStaleRunning, nothingToSubmit, shownDoubt, submitBlocked } from '../../../../../core/review/review-submit.js';
import { reviewDraftsApi } from '../../../api/review-drafts-api.js';
import { useSse } from '../../../api/events.js';
import { timeAgo } from '../../../utils/time.js';
import { ReviewProvider } from '../../../state/ReviewProvider.js';
import { ResizeDivider, useResizableSize, type ResizeSpec } from '../../Layout/ResizeDivider.js';
import {
  commentWalk,
  fixingLines,
  fixMyselfBlocked,
  groupReviews,
  notPreparedLine,
  pendingDrafts,
  reviewPages,
} from '../../../state/review-view.js';
import type { ReviewRoute } from '../../../state/dashboard-route.js';
import { reviewActionFor } from '../../../state/shortcuts.js';
import { modalOpen } from '../../../state/modal-open.js';
import { marksKey, readMarks, toggled, writeMarks } from '../../../state/review-prefs.js';
import { FixMyselfDialog } from '../FixMyselfDialog.js';
import { ReviewOverview } from './review/ReviewOverview.js';
import { StoryPager } from './review/StoryPager.js';
import { CommentWalk } from './review/CommentWalk.js';
import { FilesView } from './review/FilesView.js';
import { HostThreadsProvider } from '../../../state/HostThreads.js';
import { placeThreads } from '../../../../../core/review/review-discussion.js';

/**
 * Reviews (#64, `g v`): the PRs with a review prepared, waiting or running,
 * by repo. A review opens on its **overview** — what the PR does in short,
 * the draft comments waiting for you, the stories as cards, what no test
 * touches, and (folded) what isn't worth reading; then **Stories** reads it
 * one story at a time (its reasoning, its code files' diffs with a Viewed
 * tick, its tests folded into one line), the kinds of change no story took
 * after them; **Comments** walks the drafts one at a time with the code
 * around each. The list folds away while a review is open (Reviews ▾ in its
 * header brings it back), and the session rail can be folded on this tab.
 * **Files** is GitHub's "Files changed": every file in folder order, every
 * diff in one scroll, the same Viewed ticks. The PR's existing discussion on
 * its host (read again when the review opens) sits on its lines, read only,
 * apart from the drafts; the threads that can't are listed with it.
 * Where you are is in the URL (#/reviews/<repo>/<n>/story/2). All drafts go
 * out as one review from the submit bar, in your name, on your click — or,
 * Fix it myself, leave it for a session on the PR's branch.
 */

const STATUS_LABEL: Record<PrReviewWire['status'], string> = {
  queued: 'queued',
  running: 'preparing…',
  ready: 'ready',
  waiting: 'waits for you',
  failed: 'failed',
};

const LIST_SPEC: ResizeSpec = {
  storageKey: 'work-web:reviews-list-width',
  cssVar: '--reviews-list-width',
  defaultPx: 300,
  min: 200,
  max: 600,
  axis: 'x',
  label: 'Resize the list of reviews',
};

const GROUP_KEY = 'work-web:reviews-group';
const readGroup = (): 'repo' | 'none' => {
  try {
    return localStorage.getItem(GROUP_KEY) === 'none' ? 'none' : 'repo';
  } catch {
    return 'repo';
  }
};

interface Props {
  /** The review open and where in it (the URL's); with no `onRoute`, kept here. */
  route?: ReviewRoute | null;
  /** Move to a review, a mode, a story or a comment (null: back to the list). */
  onRoute?: (r: ReviewRoute | null) => void;
  /** The session rail folded on this tab (per browser), and its toggle. */
  railFolded?: boolean;
  onToggleRail?: () => void;
  /** The PR on screen (for the Ctrl+K assistant), or null. */
  onShown?: (pr: { repo: string; number: number } | null) => void;
  /** Opens the Ctrl+K assistant on this review. */
  onAsk?: () => void;
  /** Opens a session on its Terminal tab (Fix it myself's, once it has the comments). */
  onOpenSession?: (id: string) => void;
  /** A session's name, for "being fixed in …" (null: unknown — its branch then). */
  sessionName?: (id: string) => string | null;
}

export function ReviewsTab({ route, onRoute, railFolded, onToggleRail, onShown, onAsk, onOpenSession, sessionName }: Props) {
  const [list, setList] = useState<ReviewsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [own, setOwn] = useState<ReviewRoute | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [group, setGroup] = useState<'repo' | 'none'>(readGroup);
  const layoutRef = useRef<HTMLDivElement>(null);
  const { size: listWidth, setSize: setListWidth } = useResizableSize(LIST_SPEC);
  const selected = onRoute ? (route ?? null) : own;
  const go = useCallback((r: ReviewRoute | null) => (onRoute ? onRoute(r) : setOwn(r)), [onRoute]);
  const load = useCallback(() => {
    fetchReviews().then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);
  useSse('/events', { events: { 'reviews-changed': load } });
  const groups = useMemo(() => groupReviews(list?.reviews ?? [], group), [list, group]);
  const shownPr = selected ? { repo: selected.repo, number: selected.number } : null;
  useEffect(() => onShown?.(shownPr), [shownPr?.repo, shownPr?.number, onShown]); // eslint-disable-line react-hooks/exhaustive-deps -- by value: a new object each render
  const pickGroup = (g: 'repo' | 'none') => {
    setGroup(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      /* per browser, best effort */
    }
  };
  // The list is the page while no review is open; with one open it folds away (Reviews ▾ brings it back).
  const showList = !selected || listOpen || showSettings;

  return (
    <div
      className={`wd-reviews${showList ? '' : ' wd-reviews-nolist'}${selected ? '' : ' wd-reviews-listonly'}`}
      ref={layoutRef}
      style={{ ['--reviews-list-width' as string]: `${listWidth}px` }}
    >
      {showList && (
        <aside className="wd-reviews-list" aria-label="Pull requests to review">
          <div className="wd-reviews-head">
            <h2 className="wd-start-title">Reviews</h2>
            <button type="button" className="wd-link-button" onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? 'Close settings' : 'Which PRs…'}
            </button>
          </div>
          <div className="wd-reviews-grouping" role="group" aria-label="Group the reviews">
            Group:{' '}
            <button type="button" className={group === 'repo' ? 'wd-seg wd-seg-on' : 'wd-seg'} onClick={() => pickGroup('repo')}>
              Repo
            </button>
            <button type="button" className={group === 'none' ? 'wd-seg wd-seg-on' : 'wd-seg'} onClick={() => pickGroup('none')}>
              None
            </button>
          </div>
          {list && (
            <p className="wd-start-note">
              {list.today} prepared today
              {list.maxPerDay !== null ? ` of ${list.maxPerDay}` : ''}
            </p>
          )}
          {error && <p className="wd-modal-error">{error}</p>}
          {!error && list === null && <p className="wd-start-note">Loading…</p>}
          {list && list.reviews.length === 0 && (
            <p className="wd-start-note">No reviews yet: open pull requests of your repos are prepared here in the background.</p>
          )}
          {groups.map((g) => (
            <section key={g.repo ?? 'all'} className="wd-reviews-group">
              {g.repo && (
                <h3 className="wd-reviews-group-head">
                  {g.repo}{' '}
                  <span className="wd-start-note">
                    · {g.reviews.length}
                    {g.host ? ` · ${hostName(g.host)}` : ''}
                  </span>
                </h3>
              )}
              <ul>
                {g.reviews.map((r) => (
                  <li key={`${r.repo}#${r.number}`}>
                    <button
                      type="button"
                      className={`wd-reviews-row${selected?.repo === r.repo && selected.number === r.number ? ' wd-reviews-row-active' : ''}`}
                      onClick={() => {
                        go({
                          repo: r.repo,
                          number: r.number,
                          mode: 'overview',
                          at: 0,
                        });
                        setShowSettings(false);
                        setListOpen(false);
                      }}
                    >
                      <span className="wd-reviews-row-title">
                        {g.repo ? '' : `${r.repo} `}#{r.number} · {r.title}
                      </span>
                      <span className="wd-reviews-row-meta">
                        <span className={`wd-reviews-status wd-reviews-status-${r.status}`}>{STATUS_LABEL[r.status]}</span> @{r.author} · +
                        {r.size.added} −{r.size.deleted}
                        {r.status === 'ready' && ` · ${r.stories} stor${r.stories === 1 ? 'y' : 'ies'}`}
                        {r.flags > 0 && ` · ${r.flags} flag${r.flags === 1 ? '' : 's'}`}
                        {r.gaps > 0 && ` · ${r.gaps} untested`} · {timeAgo(r.at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </aside>
      )}
      {showList && selected && <ResizeDivider layoutRef={layoutRef} size={listWidth} onCommit={setListWidth} spec={LIST_SPEC} />}
      <section className="wd-reviews-main">
        {showSettings ? (
          <ReviewSettings />
        ) : selected ? (
          <ReviewView
            key={`${selected.repo}#${selected.number}`}
            route={selected}
            onRoute={go}
            listOpen={listOpen}
            onToggleList={() => setListOpen((v) => !v)}
            count={list?.reviews.length ?? null}
            railFolded={railFolded}
            onToggleRail={onToggleRail}
            onAsk={onAsk}
            onOpenSession={onOpenSession}
            sessionName={sessionName}
          />
        ) : (
          list &&
          list.reviews.length > 0 && <p className="wd-start-note wd-reviews-pick">Pick a pull request on the left to read its review.</p>
        )}
      </section>
    </div>
  );
}

function ReviewView({
  route,
  onRoute,
  listOpen,
  onToggleList,
  count,
  railFolded,
  onToggleRail,
  onAsk,
  onOpenSession,
  sessionName,
}: {
  route: ReviewRoute;
  onRoute: (r: ReviewRoute | null) => void;
  listOpen: boolean;
  onToggleList: () => void;
  count: number | null;
  railFolded?: boolean;
  onToggleRail?: () => void;
  onAsk?: () => void;
  onOpenSession?: (id: string) => void;
  sessionName?: (id: string) => string | null;
}) {
  const { repo, number } = route;
  const [r, setR] = useState<PrReviewWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ParsedFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [looked, setLooked] = useState<Set<string>>(new Set());
  const load = useCallback(() => {
    fetchReview(repo, number).then(setR, (e: Error) => setError(e.message));
  }, [repo, number]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'reviews-changed': load } });
  // Opened: the PR's discussion is read again from its host (the server says when that's due: at most once a minute).
  useEffect(() => {
    refreshReviewDiscussion(repo, number).then(setR, () => undefined);
  }, [repo, number]);
  useEffect(() => {
    if (r?.status !== 'ready') return;
    fetchReviewDiff(repo, number).then(
      (d) => setFiles(d.files),
      () => setFiles([]),
    );
  }, [repo, number, r?.status, r?.headSha]);
  // What you ticked, per browser and per head: a new push is a new review to read.
  const headSha = r?.headSha;
  useEffect(() => {
    if (!headSha) return;
    setViewed(readMarks(marksKey('viewed', { repo, number, headSha })));
    setLooked(readMarks(marksKey('looked', { repo, number, headSha })));
  }, [repo, number, headSha]);
  const pages = useMemo(() => (r ? reviewPages(r) : []), [r]);
  // The PR's threads on its host: on their lines in the diffs, or — outdated, or on a line the diff doesn't show — listed.
  const placed = useMemo(() => placeThreads(r?.discussion, files ?? []), [r?.discussion, files]);
  const hostThreads = useMemo(() => ({ inline: placed.inline, ...(r?.host ? { host: r.host } : {}) }), [placed, r?.host]);
  const walk = useMemo(() => (r ? commentWalk(r, pages) : []), [r, pages]);
  const api = useMemo(() => reviewDraftsApi(repo, number, setR), [repo, number]);
  // The drafts reload with the review (a sweep, the other window): the comment rows read them fresh.
  const draftsKey = r ? r.drafts.map((d) => `${d.id}:${d.state}`).join(',') : '';
  const mode = r?.status === 'ready' ? route.mode : 'overview';
  const storyAt = Math.max(0, Math.min(route.mode === 'story' ? route.at : 0, pages.length - 1));
  const commentAt = Math.max(0, Math.min(route.mode === 'comments' ? route.at : 0, walk.length - 1));
  const goMode = useCallback(
    (m: ReviewRoute['mode'], at = 0, file?: string) => onRoute({ repo, number, mode: m, at, ...(file ? { file } : {}) }),
    [onRoute, repo, number],
  );

  // The review's keys ([ ] o s m): only on a prepared review, never while typing or with a dialog up.
  useEffect(() => {
    if (r?.status !== 'ready') return;
    const onKey = (e: KeyboardEvent) => {
      const action = reviewActionFor(e);
      if (!action) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (modalOpen()) return;
      e.preventDefault();
      if (action === 'overview') return goMode('overview');
      if (action === 'stories') return goMode('story', route.mode === 'story' ? storyAt : 0);
      if (action === 'comments') return goMode('comments', route.mode === 'comments' ? commentAt : 0);
      if (action === 'files') return goMode('files', 0, route.mode === 'files' ? route.file : undefined);
      const step = action === 'next' ? 1 : -1;
      if (route.mode === 'comments') {
        const next = commentAt + step;
        if (next >= 0 && next < walk.length) goMode('comments', next);
      } else if (route.mode === 'story') {
        const next = storyAt + step;
        if (next >= 0 && next < pages.length) goMode('story', next);
      } else if (step > 0 && pages.length) goMode('story', 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r?.status, route.mode, route.file, storyAt, commentAt, walk.length, pages.length, goMode]);

  if (error) return <p className="wd-modal-error">{error}</p>;
  if (!r) return <p className="wd-start-note">Loading…</p>;
  const prepare = () => {
    setBusy(true);
    prepareReview(repo, number)
      .then(setR, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  // A review left preparing by a work web that stopped: its button works again.
  const preparing = busy || (r.status === 'running' && !isStaleRunning(r, new Date()));
  const settle = (went: boolean) => settleReviewInDoubt(repo, number, went).then(setR, (e: Error) => setError(e.message));
  // In doubt: a submit that failed without a clear answer, or one a stopped work web left mid-way (`submitting.stale`).
  const doubt = shownDoubt(r);
  const clearDropped = () => void clearReviewDropped(repo, number).then(setR, (e: Error) => setError(e.message));
  const markViewed = (path: string, on: boolean) =>
    setViewed((v) => {
      const next = toggled(v, path, on);
      writeMarks(marksKey('viewed', r), next);
      return next;
    });
  const markLooked = (id: string, on: boolean) =>
    setLooked((v) => {
      const next = toggled(v, id, on);
      writeMarks(marksKey('looked', r), next);
      return next;
    });
  const ready = r.status === 'ready';
  const modes = [
    ['overview', 'Overview', 'o'],
    ['story', `Stories (${pages.filter((p) => p.story).length})`, 's'],
    ['comments', `Comments (${walk.length})`, 'm'],
    ['files', `Files (${r.files.length})`, 'f'],
  ] as const;

  return (
    <article className="wd-review">
      <header className="wd-review-header">
        <div className="wd-review-crumbs">
          {onToggleRail && (
            <button
              type="button"
              className="wd-btn-secondary wd-review-railbtn"
              onClick={onToggleRail}
              title={railFolded ? 'Show the sessions on the left' : 'Fold the sessions away: more room for the review'}
              aria-pressed={!!railFolded}
            >
              {railFolded ? '» Sessions' : '« Sessions'}
            </button>
          )}
          <button
            type="button"
            className={`wd-btn-secondary wd-review-listbtn${listOpen ? ' wd-review-listbtn-on' : ''}`}
            onClick={onToggleList}
            aria-expanded={listOpen}
            title="The other pull requests to review"
          >
            Reviews{count !== null ? ` (${count})` : ''} ▾
          </button>
          <h2>
            <span className="wd-review-repo">{r.repo}</span>{' '}
            <a href={r.url} target="_blank" rel="noreferrer" title={`Open it on ${hostName(r.host)}`}>
              #{r.number}
            </a>{' '}
            <span className="wd-review-title" title={r.title}>
              {r.title}
            </span>
          </h2>
        </div>
        <div className="wd-review-metaline">
          <p className="wd-start-note">
            by @{r.author} · {r.branch} → {r.base} · {r.size.files} files, +{r.size.added} −{r.size.deleted} ·{' '}
            <span className={`wd-reviews-status wd-reviews-status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
            {r.why && <> · {r.why}</>}
            {r.submitted && (
              <>
                {' '}
                · you submitted{' '}
                {r.submitted.event === 'approve'
                  ? 'an approval'
                  : r.submitted.event === 'request-changes'
                    ? 'changes requested'
                    : 'a review'}{' '}
                {timeAgo(r.submitted.at)}
                {r.submitted.partial && ' — only part of it went out (the rest are still drafts)'}
                {r.submitted.url && (
                  <>
                    {' '}
                    <a href={r.submitted.url} target="_blank" rel="noreferrer">
                      ↗
                    </a>
                  </>
                )}
              </>
            )}
          </p>
          <div className="wd-review-actions">
            <button type="button" className="wd-btn-secondary" onClick={prepare} disabled={preparing}>
              {preparing ? 'Preparing…' : r.status === 'ready' ? 'Prepare again' : 'Prepare it now'}
            </button>
            {onAsk && (
              <button type="button" className="wd-btn-secondary" onClick={onAsk}>
                Ask about this review
              </button>
            )}
          </div>
        </div>
        {doubt && (
          <div className="wd-review-in-doubt" role="alert">
            <p className="wd-review-warn">
              Your submit {timeAgo(doubt.at)} may have gone out ({doubt.error}):{' '}
              {doubt.drafts.length ? `${doubt.drafts.length} comment${doubt.drafts.length === 1 ? '' : 's'}` : ''}
              {doubt.drafts.length && doubt.summary ? ' and ' : ''}
              {doubt.summary ? 'the summary' : ''}
              {doubt.partial ? ' (what came after it wasn’t sent: if it went, only part of the review did)' : ''}. Look at the PR on{' '}
              <a href={r.url} target="_blank" rel="noreferrer">
                {hostName(r.host)}
              </a>
              ; nothing is sent again until you say.
            </p>
            <button type="button" className="wd-btn-secondary" onClick={() => void settle(true)}>
              It went out
            </button>{' '}
            <button type="button" className="wd-btn-secondary" onClick={() => void settle(false)}>
              It didn&apos;t: let me send it
            </button>
          </div>
        )}
        {fixingLines(r, (id) => sessionName?.(id) ?? null).map((f, i) => (
          <p key={`${f.sessionId}:${i}`} className="wd-start-note wd-review-fixing">
            {f.text}
            {onOpenSession && (
              <>
                {' '}
                <button type="button" className="wd-link-button" onClick={() => onOpenSession(f.sessionId)}>
                  Open it →
                </button>
              </>
            )}
          </p>
        ))}
        {ready && (
          <div className="wd-review-modes" role="tablist" aria-label="Read the review">
            {modes.map(([m, label, key]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? 'wd-seg wd-seg-on' : 'wd-seg'}
                onClick={() => goMode(m, m === 'story' && route.mode === 'story' ? storyAt : 0)}
                title={`${label} — key ${key}`}
              >
                {label}
              </button>
            ))}
            <span className="wd-start-note wd-review-keys">[ ] previous / next</span>
          </div>
        )}
      </header>

      {!ready && <p className="wd-start-note wd-review-not-prepared">{notPreparedLine(r)}</p>}
      {ready && (
        <ReviewProvider key={draftsKey} api={api}>
          <HostThreadsProvider value={hostThreads}>
            <div className="wd-review-mode-body">
              {mode === 'overview' && (
                <ReviewOverview
                  review={r}
                  pages={pages}
                  walk={walk}
                  looked={looked}
                  onLooked={markLooked}
                  onStory={(p) => goMode('story', p)}
                  onComment={(i) => goMode('comments', i)}
                  onClearDropped={clearDropped}
                  aside={placed.aside}
                  onFiles={() => goMode('files')}
                />
              )}
              {mode === 'story' && (
                <StoryPager
                  review={r}
                  pages={pages}
                  at={storyAt}
                  files={files}
                  viewed={viewed}
                  onViewed={markViewed}
                  onGo={(p) => goMode('story', p)}
                  onOverview={() => goMode('overview')}
                  aside={placed.aside}
                />
              )}
              {mode === 'comments' && (
                <CommentWalk
                  review={r}
                  walk={walk}
                  at={commentAt}
                  pages={pages}
                  files={files}
                  looked={looked}
                  onLooked={markLooked}
                  onGo={(i) => goMode('comments', i)}
                  onStory={(p) => goMode('story', p)}
                  onClearDropped={clearDropped}
                />
              )}
              {mode === 'files' && (
                <FilesView
                  review={r}
                  files={files}
                  viewed={viewed}
                  onViewed={markViewed}
                  {...(route.file ? { file: route.file } : {})}
                  onFile={(path) => goMode('files', 0, path)}
                  aside={placed.aside}
                />
              )}
            </div>
          </HostThreadsProvider>
        </ReviewProvider>
      )}
      {/* Outside the provider (remounted when the drafts change): a submit's error stays on screen. In every state:
          a PR held for its size, or whose preparing failed, can still be approved (reported: no way to just approve). */}
      <SubmitBar review={r} onDone={setR} onOpenSession={onOpenSession} />
    </article>
  );
}
/** The review's drafts go out together: a verdict, a summary, and every draft still on the diff. */
function SubmitBar({
  review,
  onDone,
  onOpenSession,
}: {
  review: PrReviewWire;
  onDone: (r: PrReviewWire) => void;
  onOpenSession?: (id: string) => void;
}) {
  const [sending, setSending] = useState<ReviewEvent | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const blocked = fixMyselfBlocked(review);
  const drafts = pendingDrafts(review);
  const stopped = submitBlocked(review);
  const submit = (event: ReviewEvent) => {
    setBusy(true);
    setSending(event);
    setError(null);
    submitReview(review.repo, review.number, { event, body, drafts: drafts.map((d) => ({ id: d.id, body: d.body })) })
      .then(
        (r) => {
          onDone(r);
          setBody('');
        },
        (e: Error) => {
          // Part of it may have gone out: the review as it stands now shows which comments did.
          if (e instanceof ReviewSubmitError && e.review) onDone(e.review);
          setError(e.message);
        },
      )
      .finally(() => {
        setBusy(false);
        setSending(null);
      });
  };
  const host = hostName(review.host);
  const inFlight = busy || (!!review.submitting && !review.submitting.stale);
  // One button per verdict, each saying what it sends: Approve needs nothing else, the others a comment or a summary.
  const verdicts: Array<{ event: ReviewEvent; label: string; title: string; primary?: boolean }> = [
    { event: 'comment', label: 'Comment', title: `Post the comments and the summary on ${host}, no verdict` },
    { event: 'request-changes', label: 'Request changes', title: `Post them on ${host}, asking for changes` },
    { event: 'approve', label: 'Approve', title: `Approve the PR on ${host}, with whatever comments and summary are here`, primary: true },
  ];
  return (
    <div className="wd-review-submit" aria-label="Submit the review">
      <span>
        {drafts.length} comment{drafts.length === 1 ? '' : 's'} on the diff
      </span>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={1}
        placeholder="Summary (optional)"
        aria-label="Review summary"
      />
      {verdicts.map((v) => {
        const empty = nothingToSubmit(review, v.event, drafts.length, body);
        return (
          <button
            key={v.event}
            type="button"
            className={v.primary ? 'wd-btn-primary' : 'wd-btn-secondary'}
            disabled={inFlight || !!stopped || empty}
            title={stopped ?? (empty ? 'Write a comment on the diff or a summary first' : v.title)}
            onClick={() => submit(v.event)}
          >
            {sending === v.event ? 'Submitting…' : v.label}
          </button>
        );
      })}
      <button
        type="button"
        className="wd-btn-secondary"
        disabled={busy || !!blocked}
        title={blocked ?? 'Make the ticked comments yourself, in a session on the PR’s branch, instead of posting them'}
        onClick={() => setFixing(true)}
      >
        Fix it myself…
      </button>
      {error && <span className="wd-modal-error">{error}</span>}
      {note && <span className="wd-review-warn">{note}</span>}
      {fixing && (
        <FixMyselfDialog
          review={review}
          onClose={() => setFixing(false)}
          onDone={(out) => {
            setFixing(false);
            onDone(out.review);
            setNote(out.warnings?.length ? out.warnings.join(' · ') : null);
            onOpenSession?.(out.sessionId);
          }}
        />
      )}
    </div>
  );
}

function ReviewSettings() {
  const [s, setS] = useState<ReviewSettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchReviewSettings().then(setS, (e: Error) => setError(e.message));
  }, []);
  const set = (project: string, mode: ReviewMode) => saveReviewMode(project, mode).then(setS, (e: Error) => setError(e.message));
  return (
    <section className="wd-review-section" aria-label="Which PRs are reviewed">
      <h3>Which pull requests get a review prepared</h3>
      <p className="wd-start-note">
        Every open PR of a project by default (never your own, never drafts); only those asking for your review; or none. A repo&apos;s own
        setting wins over its group&apos;s. Each review is an AI run on your plan
        {s
          ? `${s.maxPerDay !== null ? `, at most ${s.maxPerDay} a day` : ''}; a PR over ${s.maxLines} changed lines waits for your click.`
          : '.'}
      </p>
      {error && <p className="wd-modal-error">{error}</p>}
      <table className="wd-review-settings">
        <tbody>
          {s?.projects.map((p) => (
            <tr key={`${p.kind}:${p.name}`}>
              <td>
                {p.name} <span className="wd-start-note">{p.kind}</span>
              </td>
              <td>
                <select
                  value={p.mode}
                  onChange={(e) => void set(p.name, e.target.value as ReviewMode)}
                  aria-label={`Reviews for ${p.name}`}
                >
                  <option value="all">every open PR</option>
                  <option value="asked">only those asking me</option>
                  <option value="off">none</option>
                </select>
                {p.from === 'group' && <span className="wd-start-note"> (from the group {p.group})</span>}
                {p.from === 'default' && <span className="wd-start-note"> (the default)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
