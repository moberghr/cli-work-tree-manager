import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PrReviewWire, ReviewMode, ReviewSettingsWire, ReviewsWire, ReviewSummaryWire } from '../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../core/diff/diff-parse.js';
import { FOLDED_KINDS, KIND_LABEL, KIND_ORDER, type ChangeKind } from '../../../../../core/review/change-kinds.js';
import { FLAG_LABEL } from '../../../../../core/review/review-plan.js';
import { hostName } from '../../../../../core/hosts/commands.js';
import {
  discardReviewDraft,
  fetchReview,
  fetchReviewDiff,
  fetchReviews,
  fetchReviewSettings,
  postReviewDraft,
  prepareReview,
  saveReviewMode,
} from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';
import { relativeTime } from '../../../utils/time.js';
import { DiffFile } from '../../Diff/DiffFile.js';

/**
 * Reviews (#64, `g v`): the PRs with a review prepared, waiting or running,
 * newest push first; opening one shows it by kind of change — the tests and
 * what nothing tests first, then the stories riskiest first (each saying why
 * it exists and why it's ranked there), then every file in its group (each
 * saying which rule put it there), the mechanical and generated ones folded.
 * Draft comments are posted only on your click. Which projects are reviewed
 * automatically is the settings panel's.
 */

const STATUS_LABEL: Record<PrReviewWire['status'], string> = {
  queued: 'queued',
  running: 'preparing…',
  ready: 'ready',
  waiting: 'waits for you',
  failed: 'failed',
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
  useEffect(() => onShown?.(picked), [picked, onShown]);
  const selected = picked ?? (list?.reviews[0] ? { repo: list.reviews[0].repo, number: list.reviews[0].number } : null);

  return (
    <div className="wd-reviews">
      <aside className="wd-reviews-list" aria-label="Pull requests to review">
        <div className="wd-reviews-head">
          <h2 className="wd-start-title">Reviews</h2>
          <button type="button" className="wd-link-button" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? 'Close settings' : 'Which PRs…'}
          </button>
        </div>
        {list && (
          <p className="wd-start-note">
            {list.today} of {list.maxPerDay} automatic reviews today
          </p>
        )}
        {error && <p className="wd-modal-error">{error}</p>}
        {!error && list === null && <p className="wd-start-note">Loading…</p>}
        {list && list.reviews.length === 0 && (
          <p className="wd-start-note">No reviews yet: open pull requests of your repos are prepared here in the background.</p>
        )}
        <ul>
          {list?.reviews.map((r) => (
            <ReviewRow
              key={`${r.repo}#${r.number}`}
              r={r}
              active={selected?.repo === r.repo && selected.number === r.number}
              onPick={() => setPicked({ repo: r.repo, number: r.number })}
            />
          ))}
        </ul>
      </aside>
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

function ReviewRow({ r, active, onPick }: { r: ReviewSummaryWire; active: boolean; onPick: () => void }) {
  return (
    <li>
      <button type="button" className={`wd-reviews-row${active ? ' wd-reviews-row-active' : ''}`} onClick={onPick}>
        <span className="wd-reviews-row-title">
          {r.repo} #{r.number} · {r.title}
        </span>
        <span className="wd-reviews-row-meta">
          <span className={`wd-reviews-status wd-reviews-status-${r.status}`}>{STATUS_LABEL[r.status]}</span> @{r.author} · +{r.size.added}{' '}
          −{r.size.deleted}
          {r.status === 'ready' && ` · ${r.stories} stor${r.stories === 1 ? 'y' : 'ies'}`}
          {r.flags > 0 && ` · ${r.flags} flag${r.flags === 1 ? '' : 's'}`}
          {r.gaps > 0 && ` · ${r.gaps} untested`} · {relativeTime(r.at)} ago
        </span>
      </button>
    </li>
  );
}

function ReviewView({ repo, number, onAsk }: { repo: string; number: number; onAsk?: () => void }) {
  const [r, setR] = useState<PrReviewWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ParsedFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Set<ChangeKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetchReview(repo, number).then(setR, (e: Error) => setError(e.message));
  }, [repo, number]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'reviews-changed': load } });
  // The diff, fetched once the review is ready (git recomputes it from the fetched head).
  useEffect(() => {
    if (r?.status !== 'ready') return;
    fetchReviewDiff(repo, number).then(
      (d) => setFiles(d.files),
      () => setFiles([]),
    );
  }, [repo, number, r?.status, r?.headSha]);
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);

  if (error) return <p className="wd-modal-error">{error}</p>;
  if (!r) return <p className="wd-start-note">Loading…</p>;
  const prepare = () => {
    setBusy(true);
    prepareReview(repo, number)
      .then(setR, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const showFile = (path: string) => setOpen((o) => (o === path ? null : path));
  const fileDiff = (path: string) => {
    if (open !== path) return null;
    const f = byPath.get(path);
    return f ? (
      <div className="wd-reviews-diff">
        <DiffFile file={f} anchor={`review-${path}`} />
      </div>
    ) : (
      <p className="wd-start-note">{files === null ? 'Loading the diff…' : 'Its diff is not available: prepare the review again.'}</p>
    );
  };
  const kinds = KIND_ORDER.map((k) => ({ kind: k, files: r.files.filter((f) => f.kind === k) })).filter((g) => g.files.length);
  const t = r.tests;

  return (
    <article className="wd-review">
      <header className="wd-review-header">
        <h2>
          <a href={r.url} target="_blank" rel="noreferrer" title={`Open it on ${hostName(r.host)}`}>
            {r.repo} #{r.number}
          </a>{' '}
          {r.title}
        </h2>
        <p className="wd-start-note">
          by @{r.author} · {r.branch} → {r.base} · {r.size.files} files, +{r.size.added} −{r.size.deleted} ·{' '}
          <span className={`wd-reviews-status wd-reviews-status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          {r.why && <> · {r.why}</>}
        </p>
        <div className="wd-review-actions">
          <button type="button" className="wd-btn-secondary" onClick={prepare} disabled={busy || r.status === 'running'}>
            {busy || r.status === 'running' ? 'Preparing…' : r.status === 'ready' ? 'Prepare again' : 'Prepare it now'}
          </button>
          {onAsk && (
            <button type="button" className="wd-btn-secondary" onClick={onAsk}>
              Ask about this review
            </button>
          )}
        </div>
      </header>

      {r.status === 'ready' && (
        <>
          <section className="wd-review-section" aria-label="Tests">
            <h3>Tests</h3>
            <p>
              {t.counts.added} added · {t.counts.changed} changed · {t.counts.removed} removed · {t.counts.skipped} skipped
            </p>
            {t.unitOnlyForSchema && <p className="wd-review-warn">The schema changes, and only unit tests changed with it.</p>}
            {t.gaps.length > 0 && <p className="wd-review-warn">No test touches: {t.gaps.join(', ')}</p>}
            {t.list.length > 0 && (
              <ul className="wd-review-tests">
                {t.list.map((x) => (
                  <li key={`${x.file}:${x.name}`} className={`wd-review-test-${x.change}`}>
                    <strong>{x.change}</strong> {x.name}
                    {x.cases ? ` (${x.cases} cases)` : ''} · {x.level} · <span className="wd-start-note">{x.file}</span>
                    {r.asserts[x.name] && <div className="wd-start-note">asserts: {r.asserts[x.name]} (AI)</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wd-review-section" aria-label="Stories">
            <h3>Stories, riskiest first</h3>
            {r.stories.map((s, i) => (
              <div key={i} className="wd-review-story">
                <div className="wd-review-story-head">
                  <strong>{s.title}</strong> <span className="wd-review-risk">risk {s.riskLevel}/5</span>
                  {s.flags.map((f) => (
                    <span key={f} className="wd-review-flag">
                      {FLAG_LABEL[f]}
                    </span>
                  ))}
                  {s.by === 'ai' && <span className="wd-start-note"> (AI)</span>}
                </div>
                <p className="wd-start-note">Why together: {s.why}</p>
                <p className="wd-start-note">Why ranked here: {s.risk}</p>
                <p className="wd-start-note">{s.tests.length ? `Tests: ${s.tests.join(', ')}` : s.gap}</p>
                <ul className="wd-review-files">
                  {s.files.map((p) => (
                    <li key={p}>
                      <button type="button" className="wd-link-button" onClick={() => showFile(p)}>
                        {p}
                      </button>
                      {fileDiff(p)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {r.unstoried.length > 0 && <p className="wd-start-note">In no story: {r.unstoried.join(', ')}</p>}
          </section>

          <section className="wd-review-section" aria-label="Files by kind">
            <h3>Every file, by kind of change</h3>
            {kinds.map((g) => {
              const folded = FOLDED_KINDS.has(g.kind) && !unfolded.has(g.kind);
              return (
                <div key={g.kind} className="wd-review-kind">
                  <button
                    type="button"
                    className="wd-link-button"
                    onClick={() =>
                      setUnfolded((u) => {
                        const n = new Set(u);
                        if (n.has(g.kind)) n.delete(g.kind);
                        else n.add(g.kind);
                        return n;
                      })
                    }
                  >
                    {folded ? '▸' : '▾'} {KIND_LABEL[g.kind]} · {g.files.length}
                  </button>
                  {!folded && (
                    <ul className="wd-review-files">
                      {g.files.map((f) => (
                        <li key={f.path}>
                          <button type="button" className="wd-link-button" onClick={() => showFile(f.path)}>
                            {f.path}
                          </button>{' '}
                          <span className="wd-start-note">
                            +{f.added} −{f.deleted} · {f.why}
                          </span>
                          {fileDiff(f.path)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>

          {r.drafts.length > 0 && (
            <section className="wd-review-section" aria-label="Draft comments">
              <h3>Draft comments</h3>
              <p className="wd-start-note">
                Notes from the AI step. Nothing is posted until you click Post, in your name on {hostName(r.host)}.
              </p>
              {r.drafts.map((d) => (
                <Draft key={d.id} repo={repo} number={number} draft={d} onChange={setR} />
              ))}
            </section>
          )}
        </>
      )}
    </article>
  );
}

function Draft({
  repo,
  number,
  draft,
  onChange,
}: {
  repo: string;
  number: number;
  draft: PrReviewWire['drafts'][number];
  onChange: (r: PrReviewWire) => void;
}) {
  const [text, setText] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (p: Promise<PrReviewWire>) => {
    setBusy(true);
    setError(null);
    p.then(onChange, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="wd-review-draft">
      <div className="wd-start-note">
        {draft.path}:{draft.line}
      </div>
      {draft.state === 'posted' ? (
        <p>
          {draft.body}{' '}
          {draft.url && (
            <a href={draft.url} target="_blank" rel="noreferrer">
              posted ↗
            </a>
          )}
        </p>
      ) : (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label={`Draft on ${draft.path}:${draft.line}`} />
          <div className="wd-review-actions">
            <button
              type="button"
              className="wd-btn-primary"
              disabled={busy || !text.trim()}
              onClick={() => act(postReviewDraft(repo, number, draft.id, text))}
            >
              Post
            </button>
            <button
              type="button"
              className="wd-btn-secondary"
              disabled={busy}
              onClick={() => act(discardReviewDraft(repo, number, draft.id))}
            >
              Discard
            </button>
          </div>
        </>
      )}
      {error && <p className="wd-modal-error">{error}</p>}
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
        setting wins over its group&apos;s. Reviews spend your agent plan:{' '}
        {s ? `at most ${s.maxPerDay} a day, and a PR over ${s.maxLines} changed lines waits for your click.` : '…'}
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
