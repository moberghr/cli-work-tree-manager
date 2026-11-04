import { useState } from 'react';
import type { PrReviewWire, ReviewDraftWire } from '../../../../../../core/api-types.js';
import { FLAG_LABEL } from '../../../../../../core/review/review-plan.js';
import {
  gist,
  inShort,
  notWorthReading,
  pageOf,
  plainProse,
  shortWhere,
  splitPath,
  storyCards,
  type ReviewPage,
} from '../../../../state/review-view.js';
import { DroppedDrafts } from './DroppedDrafts.js';
import { FolderPath, Prose } from './ReviewText.js';

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
}: {
  review: PrReviewWire;
  pages: ReviewPage[];
  walk: ReviewDraftWire[];
  looked: ReadonlySet<string>;
  onLooked: (id: string, on: boolean) => void;
  onStory: (page: number) => void;
  onComment: (at: number) => void;
  onClearDropped: () => void;
}) {
  const [testsOpen, setTestsOpen] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const short = inShort(r);
  const cards = storyCards(r, pages);
  const noise = notWorthReading(r);
  const kinds = pages.map((p, i) => ({ p, i })).filter(({ p }) => !p.story && !p.folded);
  const t = r.tests;
  const left = walk.filter((d) => !looked.has(d.id)).length;
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
      <div className="wd-review-overview-cols">
        <section className="wd-review-attention" aria-label="Needs your attention">
          <h3>
            Needs your attention{' '}
            <span className="wd-start-note">{walk.length ? `· ${left} of ${walk.length} to look at` : '· nothing flagged'}</span>
          </h3>
          {walk.length === 0 && <p className="wd-start-note">No draft comments: the AI step found nothing to point at.</p>}
          <ul>
            {walk.map((d, i) => (
              <li key={d.id} className={looked.has(d.id) ? 'wd-review-looked' : undefined}>
                <input
                  type="checkbox"
                  checked={looked.has(d.id)}
                  onChange={(e) => onLooked(d.id, e.target.checked)}
                  aria-label={`Looked at ${shortWhere(d)}`}
                  title="Looked at (only in this browser)"
                />
                <button type="button" className="wd-review-attention-item" onClick={() => onComment(i)} title={`${d.path}:${d.line}`}>
                  <span className="wd-review-where">{shortWhere(d)}</span>
                  {d.by === 'you' && <span className="wd-start-note"> · yours</span>}
                  <span className="wd-review-gist">{gist(d.body)}</span>
                </button>
              </li>
            ))}
          </ul>
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
                      {c.flags.map((f) => (
                        <span key={f} className="wd-review-flag">
                          {FLAG_LABEL[f]}
                        </span>
                      ))}
                    </span>
                    <span className="wd-review-card-facts">
                      {c.codeFiles} file{c.codeFiles === 1 ? '' : 's'}
                      {c.comments > 0 && ` · ${c.comments} comment${c.comments === 1 ? '' : 's'}`} ·{' '}
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
              const { name, folder } = splitPath(g);
              const page = pageOf(pages, g);
              return (
                <li key={g}>
                  <button type="button" className="wd-link-button" disabled={page < 0} onClick={() => onStory(page)} title={g}>
                    {name}
                  </button>{' '}
                  <FolderPath folder={folder} />
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
                <li key={f.path} title={f.path}>
                  {splitPath(f.path).name} <span className="wd-review-folder">{f.why}</span>
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
