import { useMemo } from 'react';
import type { PrReviewWire, ReviewDraftWire } from '../../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../../core/diff/diff-parse.js';
import { DiffFile } from '../../../Diff/DiffFile.js';
import { commentContext, gist, pageOf, shortWhere, splitPath, type ReviewPage } from '../../../../state/review-view.js';
import { DroppedDrafts } from './DroppedDrafts.js';
import { FileSummary, FolderPath, Prose } from './ReviewText.js';

/**
 * The draft comments one at a time, in the review's order: each with the code
 * around it (both sides of its hunk), its text on its line as in the diff —
 * Delete there, as everywhere a draft is shown — and a way into its story.
 * The comments set aside (not on a line of the diff) are listed at the end.
 */
export function CommentWalk({
  review: r,
  walk,
  at,
  pages,
  files,
  looked,
  onLooked,
  onGo,
  onStory,
  onClearDropped,
}: {
  review: PrReviewWire;
  walk: ReviewDraftWire[];
  at: number;
  pages: ReviewPage[];
  files: ParsedFile[] | null;
  looked: ReadonlySet<string>;
  onLooked: (id: string, on: boolean) => void;
  onGo: (at: number) => void;
  onStory: (page: number) => void;
  onClearDropped: () => void;
}) {
  const d = walk[at];
  const file = useMemo(() => (d ? files?.find((f) => f.path === d.path) : undefined), [d, files]);
  const around = useMemo(() => (file && d ? commentContext(file, d.line) : null), [file, d]);
  const page = d ? pageOf(pages, d.path) : -1;
  const summary = d ? r.files.find((f) => f.path === d.path)?.summary : undefined;
  return (
    <div className="wd-review-walk">
      <div className="wd-review-pagerbar" role="navigation" aria-label="Comments">
        <button type="button" className="wd-btn-secondary" disabled={at <= 0} onClick={() => onGo(at - 1)} aria-label="Previous comment">
          ←
        </button>
        <strong className="wd-review-pager-pos">{walk.length ? `${at + 1} of ${walk.length}` : 'No comments'}</strong>
        <button
          type="button"
          className="wd-btn-secondary"
          disabled={at >= walk.length - 1}
          onClick={() => onGo(at + 1)}
          aria-label="Next comment"
        >
          →
        </button>
        {d && (
          <>
            <span className="wd-review-walk-where" title={d.path}>
              {shortWhere(d)} <FolderPath folder={splitPath(d.path).folder} />
            </span>
            <label className="wd-review-walk-looked">
              <input type="checkbox" checked={looked.has(d.id)} onChange={(e) => onLooked(d.id, e.target.checked)} /> Looked at
            </label>
            {page >= 0 && (
              <button type="button" className="wd-link-button" onClick={() => onStory(page)}>
                Open in {pages[page].story ? `story ${page + 1}` : pages[page].label} →
              </button>
            )}
          </>
        )}
      </div>
      <div className="wd-review-walk-pane">
        {!d && <p className="wd-start-note">No draft comments on this review: add one on any line of a story&apos;s diff.</p>}
        {d && page >= 0 && (
          <p className="wd-start-note wd-review-walk-story">
            In <Prose text={pages[page].label} />
          </p>
        )}
        {d &&
          (around ? (
            <DiffFile
              key={d.id}
              file={around}
              anchor={`review-walk-${d.id}`}
              review
              repo={r.repo}
              note={summary ? <FileSummary summary={summary} /> : undefined}
            />
          ) : (
            <div className="wd-review-walk-plain">
              {summary && <FileSummary summary={summary} />}
              <p className="wd-start-note">
                {files === null ? 'Loading the diff…' : "This line's code isn't in the diff: the comment on its own."}
              </p>
              <div className="wd-review-walk-body">{d.body}</div>
            </div>
          ))}
        {walk.length > 1 && (
          <ol className="wd-review-walk-list" aria-label="Every comment">
            {walk.map((c, i) => (
              <li key={c.id} className={(i === at ? 'wd-review-walk-current ' : '') + (looked.has(c.id) ? 'wd-review-looked' : '')}>
                <button type="button" className="wd-link-button" onClick={() => onGo(i)} title={`${c.path}:${c.line}`}>
                  {shortWhere(c)}
                </button>{' '}
                <span className="wd-start-note">{gist(c.body, 110)}</span>
              </li>
            ))}
          </ol>
        )}
        {r.dropped && r.dropped.length > 0 && <DroppedDrafts dropped={r.dropped} onClear={onClearDropped} />}
      </div>
    </div>
  );
}
