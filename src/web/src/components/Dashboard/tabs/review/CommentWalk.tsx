import { useMemo, type ReactNode } from 'react';
import type { PrReviewWire, ReviewDraftWire } from '../../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../../core/diff/diff-parse.js';
import { DiffFile } from '../../../Diff/DiffFile.js';
import { commentContext, gist, isLocalReview, pageOf, splitPath, type ReviewPage } from '../../../../state/review-view.js';
import { DroppedDrafts } from './DroppedDrafts.js';
import { FileSummary, FileWhere, FolderPath, Prose } from './ReviewText.js';

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
  noteActions,
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
  /** What can be done with the note shown (a session's review: send it to Claude, or dismiss it). */
  noteActions?: (d: ReviewDraftWire) => ReactNode;
}) {
  const d = walk[at];
  const file = useMemo(() => (d ? files?.find((f) => f.path === d.path) : undefined), [d, files]);
  const around = useMemo(() => (file && d ? commentContext(file, d.line) : null), [file, d]);
  const page = d ? pageOf(pages, d.path) : -1;
  const statusOf = useMemo(() => new Map(r.files.map((f) => [f.path, f.status])), [r.files]);
  const summary = d ? r.files.find((f) => f.path === d.path)?.summary : undefined;
  const where = (c: ReviewDraftWire) => {
    const status = statusOf.get(c.path);
    return <FileWhere path={c.path} line={c.line} {...(status ? { status } : {})} />;
  };
  return (
    <div className="wd-review-walk">
      <div className="wd-review-pagerbar" role="navigation" aria-label="Comments">
        <button type="button" className="wd-btn-secondary" disabled={at <= 0} onClick={() => onGo(at - 1)} aria-label="Previous comment">
          ←
        </button>
        <strong className="wd-review-pager-pos">
          {walk.length ? `${at + 1} of ${walk.length}` : isLocalReview(r) ? 'No notes' : 'No comments'}
        </strong>
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
              {where(d)} <FolderPath folder={splitPath(d.path).folder} />
            </span>
            <label className="wd-review-walk-looked">
              <input type="checkbox" checked={looked.has(d.id)} onChange={(e) => onLooked(d.id, e.target.checked)} /> Looked at
            </label>
            {noteActions && <span className="wd-review-note-actions">{noteActions(d)}</span>}
            {page >= 0 && (
              <button type="button" className="wd-link-button" onClick={() => onStory(page)}>
                Open in {pages[page].story ? `story ${page + 1}` : pages[page].label} →
              </button>
            )}
          </>
        )}
      </div>
      <div className="wd-review-walk-pane">
        {!d && (
          <p className="wd-start-note">
            {isLocalReview(r) ? 'No notes on these changes.' : 'No draft comments on this review: add one on any line of a story’s diff.'}
          </p>
        )}
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
                <button type="button" className="wd-review-walk-item" onClick={() => onGo(i)} title={`${c.path}:${c.line}`}>
                  {where(c)}
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
