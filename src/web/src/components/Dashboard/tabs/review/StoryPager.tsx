import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrDiscussionThreadWire, PrReviewWire } from '../../../../../../core/api-types.js';
import { openThreadsByFile } from '../../../../../../core/review/review-discussion.js';
import { DiscussionAside } from './Discussion.js';
import type { ParsedFile } from '../../../../../../core/diff/diff-parse.js';
import { FLAG_LABEL } from '../../../../../../core/review/review-plan.js';
import { DiffFile } from '../../../Diff/DiffFile.js';
import { ResizeDivider, useResizableSize, type ResizeSpec } from '../../../Layout/ResizeDivider.js';
import {
  commentsByFile,
  fileOnScreen,
  plainProse,
  reviewProgress,
  shortLabel,
  testsLine,
  viewedCount,
  type ReviewEntry,
  type ReviewPage,
} from '../../../../state/review-view.js';
import { FileRow, FileSummary, Prose } from './ReviewText.js';
import { revealInScroller } from '../../../../utils/scroll.js';

const TREE_SPEC: ResizeSpec = {
  storageKey: 'work-web:review-tree-width',
  cssVar: '--review-tree-width',
  defaultPx: 300,
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
  aside = [],
}: {
  review: PrReviewWire;
  pages: ReviewPage[];
  at: number;
  files: ParsedFile[] | null;
  viewed: ReadonlySet<string>;
  onViewed: (path: string, on: boolean) => void;
  onGo: (at: number) => void;
  onOverview: () => void;
  /** The PR's threads not on a line of the diff: this page's files' are listed above its diffs. */
  aside?: PrDiscussionThreadWire[];
}) {
  const page = pages[at];
  const bodyRef = useRef<HTMLDivElement>(null);
  const { size: treeWidth, setSize: setTreeWidth } = useResizableSize(TREE_SPEC);
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const [testsOpen, setTestsOpen] = useState<string | null>(null);
  const testsToggle = useRef<HTMLDivElement>(null);
  // Reported: open, the tests' diffs pushed their toggle off screen and nothing closed them. Hide is at both ends of
  // them; closed from below, the page goes back to the line that opened them, not to whatever moved up under you.
  const hideTests = (fromBelow: boolean) => {
    setTestsOpen(null);
    if (fromBelow) requestAnimationFrame(() => testsToggle.current?.scrollIntoView?.({ block: 'nearest' }));
  };
  const [shown, setShown] = useState<string | null>(null);
  const comments = useMemo(() => commentsByFile(r), [r]);
  const threads = useMemo(() => openThreadsByFile(r.discussion), [r.discussion]);
  const paneRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState<string | null>(null);
  const frame = useRef(0);
  const pageKey = page?.key;
  // Keyed by the paths themselves: the pages are worked out again on every review fetch.
  const pathsKey = page ? page.code.map((e) => e.path).join('\n') : '';
  const codePaths = useMemo(() => (pathsKey ? pathsKey.split('\n') : []), [pathsKey]);
  const anchorOf = useCallback((path: string) => `review-${r.number}-${pageKey}-${path.replace(/[^\w-]/g, '_')}`, [r.number, pageKey]);
  // A file picked in the tree stays marked while the pane scrolls to it (smooth, and the diffs above may still grow),
  // until the scrolling has been quiet a moment — even when the pane can't bring it to the top.
  const picked = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The file whose diff is on screen, marked in the tree as the pane scrolls (measured once a frame).
  const track = useCallback(() => {
    if (picked.current) {
      clearTimeout(settle.current);
      settle.current = setTimeout(() => (picked.current = false), 200);
      return;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (!pane) return;
      const top = pane.getBoundingClientRect().top;
      const tops = codePaths.flatMap((path) => {
        const el = document.getElementById(anchorOf(path));
        return el ? [{ path, top: el.getBoundingClientRect().top - top }] : [];
      });
      setOnScreen(fileOnScreen(tops, 16));
    });
  }, [codePaths, anchorOf]);
  useEffect(() => {
    setOnScreen(codePaths[0] ?? null);
    picked.current = false;
    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(settle.current);
    };
  }, [codePaths]);
  if (!page) return <p className="wd-start-note">Nothing to read here.</p>;
  const mine = viewedCount(page.code, viewed);
  const all = reviewProgress(pages, viewed);
  const anchor = anchorOf;
  const goTo = (path: string) => {
    setOnScreen(path);
    picked.current = true;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => (picked.current = false), 400);
    const el = document.getElementById(anchor(path));
    if (el) revealInScroller(el, { behavior: 'smooth' });
  };
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
            note={e.summary ? <FileSummary summary={e.summary} /> : undefined}
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
                className={`wd-review-tree-head${p.story ? ` wd-review-tree-risk-${p.story.riskLevel}` : ''}`}
                onClick={() => onGo(i)}
                aria-current={i === at ? 'page' : undefined}
                title={p.story ? `${plainProse(p.label)}\n\nRisk ${p.story.riskLevel}/5` : plainProse(p.label)}
              >
                <span className="wd-review-tree-num">{p.story ? i + 1 : '·'}</span>{' '}
                <span className={p.story ? 'wd-review-tree-label' : undefined}>
                  <Prose text={p.label} />
                </span>
                {!p.story && <span className="wd-start-note"> · {p.code.length}</span>}
              </button>
              {i === at && (
                <ul>
                  {p.code.map((e) => (
                    <li key={e.path}>
                      <FileRow
                        path={e.path}
                        file={{ status: e.status, added: e.added, deleted: e.deleted, ...(e.oldPath ? { oldPath: e.oldPath } : {}) }}
                        comments={comments.get(e.path) ?? 0}
                        threads={threads.get(e.path) ?? 0}
                        viewed={viewed.has(e.path)}
                        current={onScreen === e.path}
                        folder={false}
                        bar
                        className="wd-review-tree-file"
                        nameClass="wd-review-tree-name"
                        onClick={() => goTo(e.path)}
                        title={e.summary ? `${e.path}\n\n${plainProse(e.summary)}` : `${e.path} — ${e.why}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </nav>
        <ResizeDivider layoutRef={bodyRef} size={treeWidth} onCommit={setTreeWidth} spec={TREE_SPEC} />
        <div className="wd-review-diff-pane" key={page.key} ref={paneRef} onScroll={track}>
          <section className="wd-review-section">
            <div className="wd-review-section-head">
              <h3 className={s ? 'wd-review-story-title' : undefined}>
                <Prose text={page.label} />
              </h3>
              {s ? (
                <>
                  <p className="wd-review-story-badges">
                    <span className={`wd-review-risk wd-review-risk-${s.riskLevel}`}>risk {s.riskLevel}/5</span>
                    {s.flags.map((f) => (
                      <span key={f} className="wd-review-flag">
                        {FLAG_LABEL[f]}
                      </span>
                    ))}
                    {s.by === 'ai' && <span className="wd-start-note"> · written by the AI step</span>}
                  </p>
                  <div className="wd-review-story-text">
                    {s.what && (
                      <section aria-label="What it does">
                        <h4>What it does</h4>
                        <p>
                          <Prose text={s.what} />
                        </p>
                      </section>
                    )}
                    <section aria-label="Why these files belong together">
                      <h4>Why these files belong together</h4>
                      <p>
                        <Prose text={s.why} />
                      </p>
                    </section>
                    <section aria-label="Why it’s ranked here">
                      <h4>Why it’s ranked here</h4>
                      <p>
                        <Prose text={s.risk} />
                      </p>
                    </section>
                  </div>
                  {s.gap && <p className="wd-review-warn">{s.gap}</p>}
                </>
              ) : (
                <p className="wd-start-note">
                  {page.code.length} file{page.code.length === 1 ? '' : 's'} no story took
                  {page.folded ? ': nothing to think about here' : ''}.
                </p>
              )}
              {s && (
                <div className="wd-review-story-tests" ref={testsToggle}>
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
            {(() => {
              const here = new Set([...page.code, ...page.tests].map((e) => e.path));
              const mine = aside.filter((t) => t.path && here.has(t.path));
              return mine.length ? <DiscussionAside threads={mine} {...(r.host ? { host: r.host } : {})} /> : null;
            })()}
            {s && testsOpen === page.key && (
              <div className="wd-review-story-testfiles">
                <button type="button" className="wd-link-button wd-review-tests-hide" onClick={() => hideTests(false)}>
                  ▴ Hide the tests
                </button>
                <ul>
                  {page.tests.map((e) => (
                    <li key={e.path}>
                      <FileRow path={e.path} file={e} comments={comments.get(e.path) ?? 0} detail={e.why} />
                    </li>
                  ))}
                </ul>
                {page.tests.map(fileView)}
                <button type="button" className="wd-link-button wd-review-tests-hide" onClick={() => hideTests(true)}>
                  ▴ Hide the tests
                </button>
              </div>
            )}
            {page.folded && !diffsShown ? (
              <div className="wd-review-folded-files">
                <ul>
                  {page.code.map((e) => (
                    <li key={e.path}>
                      <FileRow path={e.path} file={e} detail={e.why} />
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
                  Next: {shortLabel(plainProse(pages[at + 1].label))} →
                </button>
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
