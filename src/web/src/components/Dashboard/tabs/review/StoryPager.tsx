import { Fragment, useMemo, useRef, useState } from 'react';
import type { PrReviewWire } from '../../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../../core/diff/diff-parse.js';
import { FLAG_LABEL } from '../../../../../../core/review/review-plan.js';
import { DiffFile } from '../../../Diff/DiffFile.js';
import { ResizeDivider, useResizableSize, type ResizeSpec } from '../../../Layout/ResizeDivider.js';
import {
  nameParts,
  reviewProgress,
  splitPath,
  testsLine,
  viewedCount,
  type ReviewEntry,
  type ReviewPage,
} from '../../../../state/review-view.js';

const TREE_SPEC: ResizeSpec = {
  storageKey: 'work-web:review-tree-width',
  cssVar: '--review-tree-width',
  defaultPx: 260,
  min: 180,
  max: 520,
  axis: 'x',
  label: 'Resize the review tree',
};

/** "Story 2 of 5", or for a kind of change after them "Schema · 6 of 8". */
export function pageTitle(pages: ReviewPage[], at: number): string {
  const stories = pages.filter((p) => p.story).length;
  const p = pages[at];
  if (!p) return '';
  return p.story ? `Story ${at + 1} of ${stories}` : `${p.label} · ${at + 1} of ${pages.length}`;
}

/**
 * One story at a time: its reasoning on top, then only its code files' diffs
 * (each with a Viewed tick), its tests folded into one line that opens them.
 * The kinds of change no story took (API, schema, wiring, …) are pages after
 * the stories; the generated and mechanical ones list their files and fold
 * their diffs until asked. The tree beside it lists every page, the open
 * one's code files by name (the folder dimmed, the path on hover).
 */
export function StoryPager({
  review: r,
  pages,
  at,
  files,
  viewed,
  onViewed,
  onGo,
  onOverview,
}: {
  review: PrReviewWire;
  pages: ReviewPage[];
  at: number;
  files: ParsedFile[] | null;
  viewed: ReadonlySet<string>;
  onViewed: (path: string, on: boolean) => void;
  onGo: (at: number) => void;
  onOverview: () => void;
}) {
  const page = pages[at];
  const bodyRef = useRef<HTMLDivElement>(null);
  const { size: treeWidth, setSize: setTreeWidth } = useResizableSize(TREE_SPEC);
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const [testsOpen, setTestsOpen] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  if (!page) return <p className="wd-start-note">Nothing to read here.</p>;
  const mine = viewedCount(page.code, viewed);
  const all = reviewProgress(pages, viewed);
  const anchor = (path: string) => `review-${r.number}-${page.key}-${path.replace(/[^\w-]/g, '_')}`;
  const goTo = (path: string) => document.getElementById(anchor(path))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const diffsShown = !page.folded || shown === page.key;
  const s = page.story;
  const fileView = (e: ReviewEntry) => {
    const f = byPath.get(e.path);
    return (
      <div key={e.path} className="wd-review-file">
        {f ? (
          <DiffFile
            file={f}
            anchor={anchor(e.path)}
            review
            repo={r.repo}
            foldImports
            viewed={viewed.has(e.path)}
            onToggleViewed={(on) => onViewed(e.path, on)}
          />
        ) : (
          <p className="wd-start-note" id={anchor(e.path)}>
            {files === null ? 'Loading the diff…' : `${e.path}: its diff is not available — prepare the review again.`}
          </p>
        )}
      </div>
    );
  };
  return (
    <div className="wd-review-pager">
      <div className="wd-review-pagerbar" role="navigation" aria-label="Stories">
        <button type="button" className="wd-btn-secondary" disabled={at === 0} onClick={() => onGo(at - 1)} aria-label="Previous story">
          ←
        </button>
        <strong className="wd-review-pager-pos">{pageTitle(pages, at)}</strong>
        <button
          type="button"
          className="wd-btn-secondary"
          disabled={at >= pages.length - 1}
          onClick={() => onGo(at + 1)}
          aria-label="Next story"
        >
          →
        </button>
        <span
          className="wd-review-progress"
          title="Files ticked Viewed: in this story · in the whole review (not the generated or mechanical ones)"
        >
          {mine.viewed}/{mine.total} viewed here · {all.viewed}/{all.total} in all
          <span className="wd-review-progress-bar" aria-hidden>
            <span style={{ width: `${all.total ? Math.round((all.viewed / all.total) * 100) : 0}%` }} />
          </span>
        </span>
        <button type="button" className="wd-link-button" onClick={onOverview}>
          Overview
        </button>
      </div>
      <div className="wd-review-body" ref={bodyRef} style={{ ['--review-tree-width' as string]: `${treeWidth}px` }}>
        <nav className="wd-review-tree" aria-label="The review, in order">
          {pages.map((p, i) => (
            <div key={p.key} className={`wd-review-tree-section${i === at ? ' wd-review-tree-current' : ''}`}>
              <button
                type="button"
                className="wd-review-tree-head"
                onClick={() => onGo(i)}
                aria-current={i === at ? 'page' : undefined}
                title={p.label}
              >
                <span className="wd-review-tree-num">{p.story ? i + 1 : '·'}</span> {p.label}
                {!p.story && <span className="wd-start-note"> · {p.code.length}</span>}
              </button>
              {i === at && (
                <ul>
                  {p.code.map((e) => {
                    const { name, folder } = splitPath(e.path);
                    return (
                      <li key={e.path}>
                        <button
                          type="button"
                          className={`wd-review-tree-file${viewed.has(e.path) ? ' wd-review-tree-viewed' : ''}`}
                          onClick={() => goTo(e.path)}
                          title={`${e.path} — ${e.why}`}
                        >
                          <span className="wd-review-tree-name">
                            {viewed.has(e.path) ? '✓ ' : ''}
                            {nameParts(name).map((part, k) => (
                              <Fragment key={k}>
                                {k > 0 && <wbr />}
                                {part}
                              </Fragment>
                            ))}
                          </span>
                          <span className="wd-review-folder">
                            <span className="wd-review-tree-stat">
                              +{e.added} −{e.deleted}
                            </span>
                            {/* A zero-width space after each slash: a long folder wraps between its parts. */}
                            {folder && ` · ${folder.replace(/\//g, '/\u200b')}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </nav>
        <ResizeDivider layoutRef={bodyRef} size={treeWidth} onCommit={setTreeWidth} spec={TREE_SPEC} />
        <div className="wd-review-diff-pane" key={page.key}>
          <section className="wd-review-section">
            <div className="wd-review-section-head">
              <h3>
                {page.label}{' '}
                {s && (
                  <>
                    <span className={`wd-review-risk wd-review-risk-${s.riskLevel}`}>risk {s.riskLevel}/5</span>
                    {s.flags.map((f) => (
                      <span key={f} className="wd-review-flag">
                        {FLAG_LABEL[f]}
                      </span>
                    ))}
                    {s.by === 'ai' && <span className="wd-start-note"> (AI)</span>}
                  </>
                )}
              </h3>
              {s ? (
                <>
                  <p>
                    <strong>Why together:</strong> {s.why}
                  </p>
                  <p>
                    <strong>Why ranked here:</strong> {s.risk}
                  </p>
                  {s.gap && <p className="wd-review-warn">{s.gap}</p>}
                </>
              ) : (
                <p className="wd-start-note">
                  {page.code.length} file{page.code.length === 1 ? '' : 's'} no story took
                  {page.folded ? ': nothing to think about here' : ''}.
                </p>
              )}
              {s && (
                <div className="wd-review-story-tests">
                  <button
                    type="button"
                    className="wd-link-button"
                    disabled={!page.tests.length}
                    onClick={() => setTestsOpen((k) => (k === page.key ? null : page.key))}
                    aria-expanded={testsOpen === page.key}
                  >
                    {page.tests.length ? (testsOpen === page.key ? '▾ ' : '▸ ') : ''}
                    {testsLine(page)}
                  </button>
                </div>
              )}
            </div>
            {s && testsOpen === page.key && (
              <div className="wd-review-story-testfiles">
                <ul>
                  {page.tests.map((e) => {
                    const { name, folder } = splitPath(e.path);
                    return (
                      <li key={e.path} title={e.path}>
                        🧪 {name} <span className="wd-review-folder">{folder}</span> <span className="wd-start-note">· {e.why}</span>
                      </li>
                    );
                  })}
                </ul>
                {page.tests.map(fileView)}
              </div>
            )}
            {page.folded && !diffsShown ? (
              <div className="wd-review-folded-files">
                <ul>
                  {page.code.map((e) => (
                    <li key={e.path} title={e.path}>
                      {splitPath(e.path).name} <span className="wd-review-folder">{e.why}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" className="wd-link-button" onClick={() => setShown(page.key)}>
                  Show the diffs ▸
                </button>
              </div>
            ) : (
              page.code.map(fileView)
            )}
            {at < pages.length - 1 && (
              <p className="wd-review-next">
                <button type="button" className="wd-btn-secondary" onClick={() => onGo(at + 1)}>
                  Next: {pages[at + 1].label} →
                </button>
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
