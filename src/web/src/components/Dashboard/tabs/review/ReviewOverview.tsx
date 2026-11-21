import { useState, type ReactNode } from 'react';
import type { PrDiscussionThreadWire, PrReviewWire, ReviewDraftWire } from '../../../../../../core/api-types.js';
import { AlreadyDiscussed } from './Discussion.js';
import {
  FLAG_LABEL,
  FLOW_CHANGE_LABEL,
  NOTE_LEVEL_LABEL,
  STORY_VERDICT_LABEL,
  VERDICT_LABEL,
} from '../../../../../../core/review/review-plan.js';
import {
  commentsByFile,
  gist,
  inShort,
  notWorthReading,
  pageOf,
  plainProse,
  shortWhere,
  storyCards,
  type ReviewPage,
  attentionOrder,
  flowPages,
  isLocalReview,
  pointsLabel,
} from '../../../../state/review-view.js';
import { DroppedDrafts } from './DroppedDrafts.js';
import { FileRow, FileWhere, FLOW_TONE, Prose, STORY_VERDICT_TONE } from './ReviewText.js';
import { Badge, Button, TextArea } from '../../../../ui/index.js';

/**
 * A review's overview — where it opens: what the PR does in short, the draft
 * comments waiting for you as a checklist, the stories as cards, then what no
 * test touches and, folded, what isn't worth reading. No diff here: each part
 * leads into the story pager or the comments walk.
 */
export function ReviewOverview({
  review: r,
  pages,
  walk,
  looked,
  onLooked,
  onStory,
  onComment,
  onClearDropped,
  aside = [],
  onFiles = () => undefined,
  noteActions,
  onDecide,
}: {
  review: PrReviewWire;
  pages: ReviewPage[];
  walk: ReviewDraftWire[];
  looked: ReadonlySet<string>;
  onLooked: (id: string, on: boolean) => void;
  onStory: (page: number) => void;
  onComment: (at: number) => void;
  onClearDropped: () => void;
  /** The PR's threads not on a line of the diff (outdated, or elsewhere). */
  aside?: PrDiscussionThreadWire[];
  /** Opens the Files view. */
  onFiles?: () => void;
  /** What can be done with one note, beside it (a session's review: send it to Claude, or dismiss it). */
  noteActions?: (d: ReviewDraftWire) => ReactNode;
  /** A session's review: hand the recommendation to its agent with what you decided (empty: ask it to lay the question out). */
  onDecide?: (decision: string) => Promise<void>;
}) {
  const [decision, setDecision] = useState('');
  const [deciding, setDeciding] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [decideError, setDecideError] = useState<string | null>(null);
  const decide = () => {
    if (!onDecide) return;
    setDeciding('sending');
    setDecideError(null);
    onDecide(decision).then(
      () => {
        setDeciding('sent');
        setDecision('');
      },
      (e: Error) => {
        setDeciding('idle');
        setDecideError(e.message);
      },
    );
  };
  const [testsOpen, setTestsOpen] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const short = inShort(r);
  const cards = storyCards(r, pages);
  const noise = notWorthReading(r);
  const kinds = pages.map((p, i) => ({ p, i })).filter(({ p }) => !p.story && !p.folded);
  const t = r.tests;
  // The likely bugs first, the minor notes folded below: the list is what needs you, not everything said.
  const attention = attentionOrder(walk);
  const left = attention.main.filter(({ d }) => !looked.has(d.id)).length;
  const noteRow = ({ d, at: i }: { d: ReviewDraftWire; at: number }) => (
    <li key={d.id} className={looked.has(d.id) ? 'wd-review-looked' : undefined}>
      <input
        type="checkbox"
        checked={looked.has(d.id)}
        onChange={(e) => onLooked(d.id, e.target.checked)}
        aria-label={`Looked at ${shortWhere(d)}`}
        title="Looked at (only in this browser)"
      />
      <button type="button" className="wd-review-attention-item" onClick={() => onComment(i)} title={`${d.path}:${d.line}`}>
        <FileWhere path={d.path} line={d.line} {...(fileOf.get(d.path) ? { status: fileOf.get(d.path)!.status } : {})} />
        {d.level === 'bug' && <span className="wd-review-note-level wd-review-note-bug"> {NOTE_LEVEL_LABEL.bug}</span>}
        {d.by === 'you' && <span className="wd-start-note"> · yours</span>}
        <span className="wd-review-gist">{gist(d.body)}</span>
      </button>
      {noteActions && <span className="wd-review-note-actions">{noteActions(d)}</span>}
    </li>
  );
  const fileOf = new Map(r.files.map((f) => [f.path, f]));
  const comments = commentsByFile(r);
  return (
    <div className="wd-review-overview">
      <section className="wd-review-short" aria-label="In short">
        <h3>In short</h3>
        {'summary' in short ? (
          <p>
            <Prose text={short.summary} />
          </p>
        ) : short.bullets.length ? (
          <ul>
            {short.bullets.map((b, i) => (
              <li key={i}>
                <Prose text={b} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="wd-start-note">No summary: no AI step ran for this review.</p>
        )}
      </section>
      {r.attention && r.attention.length > 0 && (
        <p className="wd-start-note wd-review-attention-asked">Asked to pay attention to: {r.attention.join(' · ')}</p>
      )}
      {r.recommendation && (
        <section className={`wd-review-recommendation wd-review-verdict-${r.recommendation.verdict}`} aria-label="Recommendation">
          <h3>
            Recommendation <span className="wd-start-note">· the AI step’s advice: you decide</span>
          </h3>
          <p>
            <strong className="wd-review-verdict">{VERDICT_LABEL[r.recommendation.verdict]}.</strong> <Prose text={r.recommendation.text} />
            {walk.length > 0 && (
              <>
                {' '}
                <button type="button" className="wd-link-button" onClick={() => onComment(attention.main[0]?.at ?? 0)}>
                  Read the {pointsLabel(r, walk.length)} →
                </button>
              </>
            )}
          </p>
          {onDecide && (
            <div className="wd-review-decide">
              <label className="wd-start-note" htmlFor="wd-review-decision">
                Your decision on it, for this session’s Claude (empty: it is asked to lay the question out and change nothing)
              </label>
              <TextArea
                id="wd-review-decision"
                rows={3}
                value={decision}
                maxLength={4000}
                disabled={deciding === 'sending'}
                placeholder="e.g. Pay out what is due and leave the held settlement attached. Check the race and add a test."
                onChange={(e) => {
                  setDecision(e.target.value);
                  if (deciding === 'sent') setDeciding('idle');
                }}
              />
              <span className="wd-review-decide-actions">
                <Button
                  onClick={decide}
                  disabled={deciding === 'sending'}
                  title="Hands the recommendation to this session's Claude: with your decision to follow, or, left empty, a request to lay the open questions out first"
                >
                  {deciding === 'sending' ? 'Sending…' : decision.trim() ? 'Send my decision to its Claude' : 'Ask its Claude about it'}
                </Button>
                {deciding === 'sent' && (
                  <span className="wd-start-note" role="status">
                    Handed to its Claude.
                  </span>
                )}
                {decideError && <span className="wd-tab-error">{decideError}</span>}
              </span>
            </div>
          )}
        </section>
      )}
      {r.flows && r.flows.length > 0 && (
        <section className="wd-review-flows" aria-label="Flows">
          <h3>
            Flows <span className="wd-start-note">· what this adds, changes or removes, step by step</span>
          </h3>
          {r.flows.map((f, i) => (
            <details key={i} className="wd-review-flow" open={r.flows!.length <= 2}>
              <summary>
                <Badge kind="status" tone={FLOW_TONE[f.change]} className={`wd-review-flow-change wd-review-flow-${f.change}`}>
                  {FLOW_CHANGE_LABEL[f.change]}
                </Badge>{' '}
                <Prose text={f.title} />
              </summary>
              <ol>
                {f.steps.map((s, n) => (
                  <li key={n}>
                    <Prose text={s} />
                  </li>
                ))}
              </ol>
              {flowPages(f, pages).length > 0 && (
                <p className="wd-review-flow-links">
                  Its code:{' '}
                  {flowPages(f, pages).map((p) => (
                    <button key={p} type="button" className="wd-link-button" onClick={() => onStory(p)}>
                      {pages[p].story ? `story ${p + 1}` : pages[p].label} →
                    </button>
                  ))}
                </p>
              )}
            </details>
          ))}
        </section>
      )}
      {/* A session's own changes are on no host: there is no discussion to read. */}
      {!isLocalReview(r) && (
        <AlreadyDiscussed discussion={r.discussion} aside={aside} onFiles={onFiles} {...(r.host ? { host: r.host } : {})} />
      )}
      <div className="wd-review-overview-cols">
        <section className="wd-review-attention" aria-label="Needs your attention">
          <h3>
            Needs your attention{' '}
            <span className="wd-start-note">{walk.length ? `· ${left} of ${attention.main.length} to look at` : '· nothing flagged'}</span>
          </h3>
          {walk.length === 0 && (
            <p className="wd-start-note">{isLocalReview(r) ? 'No notes' : 'No draft comments'}: the AI step found nothing to point at.</p>
          )}
          <ul>{attention.main.map(noteRow)}</ul>
          {attention.minor.length > 0 && (
            <details className="wd-review-minor">
              <summary>
                {attention.minor.length} minor {attention.minor.length === 1 ? 'point' : 'points'}
              </summary>
              <ul>{attention.minor.map(noteRow)}</ul>
            </details>
          )}
          {r.dropped && r.dropped.length > 0 && <DroppedDrafts dropped={r.dropped} onClear={onClearDropped} />}
        </section>
        <section className="wd-review-stories" aria-label="Stories">
          <h3>
            Stories <span className="wd-start-note">· riskiest first{r.aiStep === 'done' ? '' : ' · by folder (no AI step)'}</span>
          </h3>
          <ol className="wd-review-cards">
            {cards.map((c) => (
              <li key={c.page}>
                <button
                  type="button"
                  className="wd-review-card"
                  onClick={() => onStory(c.page)}
                  title={plainProse(c.what ? `${c.title}\n\n${c.what}` : c.title)}
                >
                  <span className="wd-review-card-num">{c.number}</span>
                  <span className="wd-review-card-body">
                    <span className="wd-review-card-title">
                      <Prose text={c.title} />
                    </span>
                    {c.lead && (
                      <span className="wd-review-card-lead">
                        <Prose text={c.lead} />
                      </span>
                    )}
                    <span className="wd-review-card-meta">
                      <span className={`wd-review-risk wd-review-risk-${c.riskLevel}`}>risk {c.riskLevel}/5</span>
                      {c.verdict && (
                        <Badge
                          kind="status"
                          tone={STORY_VERDICT_TONE[c.verdict]}
                          className={`wd-review-story-verdict wd-review-story-verdict-${c.verdict}`}
                          title={c.verdictWhy}
                        >
                          {STORY_VERDICT_LABEL[c.verdict]}
                        </Badge>
                      )}
                      {c.flags.map((f) => (
                        <Badge key={f} kind="status" tone="warn" className="wd-review-flag">
                          {FLAG_LABEL[f]}
                        </Badge>
                      ))}
                    </span>
                    <span className="wd-review-card-facts">
                      {c.codeFiles} file{c.codeFiles === 1 ? '' : 's'}
                      {c.comments > 0 && ` · ${pointsLabel(r, c.comments)}`} ·{' '}
                      <span className={`wd-review-tests-${c.tests.state}`}>
                        {c.tests.state === 'covered' ? '✓ ' : ''}
                        {c.tests.text}
                      </span>
                      {c.tests.untested && <span className="wd-review-tests-gap"> · {c.tests.untested}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {kinds.length > 0 && (
            <p className="wd-start-note wd-review-also">
              Also in the pager:{' '}
              {kinds.map(({ p, i }, n) => (
                <span key={p.key}>
                  {n > 0 && ' · '}
                  <button type="button" className="wd-link-button" onClick={() => onStory(i)}>
                    {p.label} ({p.code.length})
                  </button>
                </span>
              ))}
            </p>
          )}
        </section>
      </div>
      {t.gaps.length > 0 && (
        <section className="wd-review-gaps" aria-label="Untested">
          <h3>
            Untested{' '}
            <span className="wd-start-note">
              · no test of the PR touches {t.gaps.length === 1 ? 'this file' : `these ${t.gaps.length} files`}
            </span>
          </h3>
          <ul>
            {t.gaps.map((g) => {
              const page = pageOf(pages, g);
              const f = fileOf.get(g);
              return (
                <li key={g}>
                  <FileRow
                    path={g}
                    {...(f ? { file: f } : {})}
                    comments={comments.get(g) ?? 0}
                    bar
                    disabled={page < 0}
                    onClick={() => onStory(page)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div className="wd-review-tests-strip">
        <button type="button" className="wd-link-button" onClick={() => setTestsOpen((v) => !v)} aria-expanded={testsOpen}>
          {testsOpen ? '▾' : '▸'} Tests: {t.counts.added} added · {t.counts.changed} changed · {t.counts.removed} removed ·{' '}
          {t.counts.skipped} skipped
        </button>
        {t.unitOnlyForSchema && <span className="wd-review-warn"> · the schema changes with unit tests only</span>}
        {testsOpen && (
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
      </div>
      {noise && (
        <div className="wd-review-noise">
          <button type="button" className="wd-link-button" onClick={() => setNoiseOpen((v) => !v)} aria-expanded={noiseOpen}>
            Not worth reading: {noise.line} {noiseOpen ? '▾' : '▸'}
          </button>
          {noiseOpen && (
            <ul>
              {noise.files.map((f) => (
                <li key={f.path}>
                  <FileRow path={f.path} file={f} detail={f.why} />
                </li>
              ))}
              {noise.ignored.map((f) => (
                <li key={f.path} className="wd-review-ignored">
                  <code>{f.path}</code>{' '}
                  <span className="wd-start-note">
                    +{f.added} −{f.deleted} · left out of the review: a {f.why}, never read
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {r.unstoried.length > 0 && <p className="wd-start-note">In no story: {r.unstoried.join(', ')}</p>}
    </div>
  );
}
