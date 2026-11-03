import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrReviewWire, ReviewEvent, ReviewMode, ReviewSettingsWire, ReviewsWire } from '../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../core/diff/diff-parse.js';
import { FLAG_LABEL } from '../../../../../core/review/review-plan.js';
import { hostName } from '../../../../../core/hosts/commands.js';
import {
  clearReviewDropped,
  fetchReview,
  fetchReviewDiff,
  fetchReviews,
  fetchReviewSettings,
  prepareReview,
  ReviewSubmitError,
  saveReviewMode,
  settleReviewInDoubt,
  submitReview,
} from '../../../api/panes.js';
import { isStaleRunning } from '../../../../../core/review/review-submit.js';
import { reviewDraftsApi } from '../../../api/review-drafts-api.js';
import { useSse } from '../../../api/events.js';
import { relativeTime } from '../../../utils/time.js';
import { DiffFile } from '../../Diff/DiffFile.js';
import { ReviewProvider } from '../../../state/ReviewProvider.js';
import { ResizeDivider, useResizableSize, type ResizeSpec } from '../../Layout/ResizeDivider.js';
import { groupReviews, pendingDrafts, reviewSections, type ReviewSection } from '../../../state/review-view.js';

/**
 * Reviews (#64, `g v`): the PRs with a review prepared, waiting or running,
 * by repo, in a list you can resize. A review reads like the Diff tab, in the
 * review's order instead of the alphabet's: the tree on the left lists the
 * stories riskiest first (each with its tests under its code), then every
 * other file by kind, the generated and mechanical ones folded; the diff on
 * the right follows it, each story's reasoning above its files. Draft
 * comments sit on their lines; you add your own the same way; all of them
 * go out as one review from the submit bar, in your name, on your click.
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
const TREE_SPEC: ResizeSpec = {
  ...LIST_SPEC,
  storageKey: 'work-web:review-tree-width',
  cssVar: '--review-tree-width',
  defaultPx: 300,
  label: 'Resize the review tree',
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
  /** The PR on screen (for the Ctrl+K assistant), or null. */
  onShown?: (pr: { repo: string; number: number } | null) => void;
  /** Opens the Ctrl+K assistant on this review. */
  onAsk?: () => void;
}

export function ReviewsTab({ onShown, onAsk }: Props) {
  const [list, setList] = useState<ReviewsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ repo: string; number: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [group, setGroup] = useState<'repo' | 'none'>(readGroup);
  const layoutRef = useRef<HTMLDivElement>(null);
  const { size: listWidth, setSize: setListWidth } = useResizableSize(LIST_SPEC);
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
  const first = groups[0]?.reviews[0];
  const selected = picked ?? (first ? { repo: first.repo, number: first.number } : null);
  useEffect(() => onShown?.(selected), [selected?.repo, selected?.number, onShown]); // eslint-disable-line react-hooks/exhaustive-deps -- by value: a new object each render
  const pickGroup = (g: 'repo' | 'none') => {
    setGroup(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      /* per browser, best effort */
    }
  };

  return (
    <div className="wd-reviews" ref={layoutRef} style={{ ['--reviews-list-width' as string]: `${listWidth}px` }}>
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
            {list.today} prepared today{list.maxPerDay !== null ? ` of ${list.maxPerDay}` : ''}
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
                      setPicked({ repo: r.repo, number: r.number });
                      setShowSettings(false);
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
                      {r.gaps > 0 && ` · ${r.gaps} untested`} · {relativeTime(r.at)} ago
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <ResizeDivider layoutRef={layoutRef} size={listWidth} onCommit={setListWidth} spec={LIST_SPEC} />
      <section className="wd-reviews-main">
        {showSettings ? (
          <ReviewSettings />
        ) : selected ? (
          <ReviewView key={`${selected.repo}#${selected.number}`} repo={selected.repo} number={selected.number} onAsk={onAsk} />
        ) : null}
      </section>
    </div>
  );
}

function ReviewView({ repo, number, onAsk }: { repo: string; number: number; onAsk?: () => void }) {
  const [r, setR] = useState<PrReviewWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ParsedFile[] | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [testsOpen, setTestsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { size: treeWidth, setSize: setTreeWidth } = useResizableSize(TREE_SPEC);
  const load = useCallback(() => {
    fetchReview(repo, number).then(setR, (e: Error) => setError(e.message));
  }, [repo, number]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'reviews-changed': load } });
  useEffect(() => {
    if (r?.status !== 'ready') return;
    fetchReviewDiff(repo, number).then(
      (d) => setFiles(d.files),
      () => setFiles([]),
    );
  }, [repo, number, r?.status, r?.headSha]);
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const sections = useMemo(() => (r ? reviewSections(r) : []), [r]);
  const api = useMemo(() => reviewDraftsApi(repo, number, setR), [repo, number]);
  // The drafts reload with the review (a sweep, the other window): the comment rows read them fresh.
  const draftsKey = r ? r.drafts.map((d) => `${d.id}:${d.state}`).join(',') : '';

  if (error) return <p className="wd-modal-error">{error}</p>;
  if (!r) return <p className="wd-start-note">Loading…</p>;
  const prepare = () => {
    setBusy(true);
    prepareReview(repo, number)
      .then(setR, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const isFolded = (s: ReviewSection) => (s.folded ? !unfolded.has(s.key) : unfolded.has(`closed:${s.key}`));
  const toggle = (s: ReviewSection) =>
    setUnfolded((u) => {
      const n = new Set(u);
      const k = s.folded ? s.key : `closed:${s.key}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const anchor = (path: string) => `review-${r.number}-${path.replace(/[^\w-]/g, '_')}`;
  const goTo = (s: ReviewSection, path: string) => {
    if (isFolded(s)) toggle(s);
    requestAnimationFrame(() => document.getElementById(anchor(path))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const t = r.tests;
  // A review left preparing by a work web that stopped: its button works again.
  const preparing = busy || (r.status === 'running' && !isStaleRunning(r, new Date()));
  const settle = (went: boolean) => settleReviewInDoubt(repo, number, went).then(setR, (e: Error) => setError(e.message));
  const clearDropped = () => clearReviewDropped(repo, number).then(setR, (e: Error) => setError(e.message));

  return (
    <article className="wd-review">
      <header className="wd-review-header">
        <h2>
          <span className="wd-review-repo">{r.repo}</span>{' '}
          <a href={r.url} target="_blank" rel="noreferrer" title={`Open it on ${hostName(r.host)}`}>
            #{r.number}
          </a>{' '}
          {r.title}
        </h2>
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
              {relativeTime(r.submitted.at)} ago
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
        {r.inDoubt && (
          <div className="wd-review-in-doubt" role="alert">
            <p className="wd-review-warn">
              Your submit {relativeTime(r.inDoubt.at)} ago may have gone out ({r.inDoubt.error}):{' '}
              {r.inDoubt.drafts.length ? `${r.inDoubt.drafts.length} comment${r.inDoubt.drafts.length === 1 ? '' : 's'}` : ''}
              {r.inDoubt.drafts.length && r.inDoubt.summary ? ' and ' : ''}
              {r.inDoubt.summary ? 'the summary' : ''}. Look at the PR on{' '}
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
        {r.dropped && r.dropped.length > 0 && (
          <details className="wd-review-dropped">
            <summary className="wd-review-warn">
              {r.dropped.length} comment{r.dropped.length === 1 ? '' : 's'} set aside: not on a line of the diff
            </summary>
            <ul>
              {r.dropped.map((d, i) => (
                <li key={`${d.path}:${d.line}:${i}`}>
                  <span className="wd-start-note">
                    {d.path}:{d.line} · {d.by === 'you' ? 'yours' : 'AI'} · {d.why}
                  </span>
                  <div>{d.body}</div>
                </li>
              ))}
            </ul>
            <button type="button" className="wd-link-button" onClick={() => void clearDropped()}>
              Forget them
            </button>
          </details>
        )}
        {r.status === 'ready' && (
          <div className="wd-review-tests-strip">
            <button type="button" className="wd-link-button" onClick={() => setTestsOpen((v) => !v)} aria-expanded={testsOpen}>
              {testsOpen ? '▾' : '▸'} Tests: {t.counts.added} added · {t.counts.changed} changed · {t.counts.removed} removed ·{' '}
              {t.counts.skipped} skipped
            </button>
            {t.gaps.length > 0 && (
              <span className="wd-review-warn">
                {' '}
                · no test touches {t.gaps.length} file{t.gaps.length === 1 ? '' : 's'}
              </span>
            )}
            {t.unitOnlyForSchema && <span className="wd-review-warn"> · the schema changes with unit tests only</span>}
            {testsOpen && (
              <div className="wd-review-tests-detail">
                {t.gaps.length > 0 && <p className="wd-review-warn">No test touches: {t.gaps.join(', ')}</p>}
                <ul className="wd-review-tests">
                  {t.list.map((x) => (
                    <li key={`${x.file}:${x.name}`} className={`wd-review-test-${x.change}`}>
                      <strong>{x.change}</strong> {x.name}
                      {x.cases ? ` (${x.cases} cases)` : ''} · {x.level} · <span className="wd-start-note">{x.file}</span>
                      {r.asserts[x.name] && <div className="wd-start-note">asserts: {r.asserts[x.name]} (AI)</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </header>

      {r.status === 'ready' && (
        <ReviewProvider key={draftsKey} api={api}>
          <div className="wd-review-body" ref={bodyRef} style={{ ['--review-tree-width' as string]: `${treeWidth}px` }}>
            <nav className="wd-review-tree" aria-label="The review, in order">
              {sections.map((s) => (
                <div key={s.key} className="wd-review-tree-section">
                  <button type="button" className="wd-review-tree-head" onClick={() => toggle(s)} aria-expanded={!isFolded(s)}>
                    {isFolded(s) ? '▸' : '▾'} {s.story ? s.label : `${s.label} · ${s.entries.length}`}
                  </button>
                  {s.story && (
                    <div className="wd-review-tree-meta">
                      risk {s.story.riskLevel}/5
                      {s.story.flags.map((f) => (
                        <span key={f} className="wd-review-flag">
                          {FLAG_LABEL[f]}
                        </span>
                      ))}
                    </div>
                  )}
                  {!isFolded(s) && (
                    <ul>
                      {s.entries.map((e) => (
                        <li key={e.path}>
                          <button
                            type="button"
                            className="wd-review-tree-file"
                            onClick={() => goTo(s, e.path)}
                            title={`${e.path} — ${e.why}`}
                          >
                            {e.role === 'test' ? '🧪 ' : ''}
                            {e.path.split('/').pop()}{' '}
                            <span className="wd-start-note">
                              +{e.added} −{e.deleted}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </nav>
            <ResizeDivider layoutRef={bodyRef} size={treeWidth} onCommit={setTreeWidth} spec={TREE_SPEC} />
            <div className="wd-review-diff-pane">
              {sections
                .filter((s) => !isFolded(s))
                .map((s) => (
                  <section key={s.key} className="wd-review-section">
                    <div className="wd-review-section-head">
                      <strong>{s.label}</strong>
                      {s.story ? (
                        <>
                          {' '}
                          <span className="wd-review-risk">risk {s.story.riskLevel}/5</span>
                          {s.story.flags.map((f) => (
                            <span key={f} className="wd-review-flag">
                              {FLAG_LABEL[f]}
                            </span>
                          ))}
                          {s.story.by === 'ai' && <span className="wd-start-note"> (AI)</span>}
                          <div className="wd-start-note">Why together: {s.story.why}</div>
                          <div className="wd-start-note">Why ranked here: {s.story.risk}</div>
                          {s.story.gap && <div className="wd-review-warn">{s.story.gap}</div>}
                        </>
                      ) : null}
                    </div>
                    {s.entries.map((e) => {
                      const f = byPath.get(e.path);
                      return (
                        <div key={e.path} id={anchor(e.path)} className="wd-review-file">
                          <div className="wd-start-note wd-review-file-why">{e.why}</div>
                          {f ? (
                            <DiffFile file={f} anchor={anchor(e.path)} review repo={r.repo} />
                          ) : (
                            <p className="wd-start-note">
                              {files === null ? 'Loading the diff…' : `${e.path}: its diff is not available — prepare the review again.`}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </section>
                ))}
              {r.unstoried.length > 0 && <p className="wd-start-note">In no story: {r.unstoried.join(', ')}</p>}
            </div>
          </div>
        </ReviewProvider>
      )}
      {/* Outside the provider (remounted when the drafts change): a submit's error stays on screen. */}
      {r.status === 'ready' && <SubmitBar review={r} onDone={setR} />}
    </article>
  );
}

/** The review's drafts go out together: a verdict, a summary, and every draft still on the diff. */
function SubmitBar({ review, onDone }: { review: PrReviewWire; onDone: (r: PrReviewWire) => void }) {
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drafts = pendingDrafts(review);
  const submit = () => {
    setBusy(true);
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
      .finally(() => setBusy(false));
  };
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
      <select value={event} onChange={(e) => setEvent(e.target.value as ReviewEvent)} aria-label="Verdict">
        <option value="comment">Comment</option>
        <option value="approve">Approve</option>
        <option value="request-changes">Request changes</option>
      </select>
      <button
        type="button"
        className="wd-btn-primary"
        disabled={busy || !!review.inDoubt || (event !== 'approve' && !drafts.length && !body.trim())}
        onClick={submit}
      >
        {busy ? 'Submitting…' : `Submit review on ${hostName(review.host)}`}
      </button>
      {error && <span className="wd-modal-error">{error}</span>}
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
