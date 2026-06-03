import { Fragment, useMemo } from 'react';
import type { Hunk } from '../../api/client.js';
import {
  hunkRows,
  type IntraSpan,
  type SideRow,
} from '../../utils/intraline.js';
import { useReviewOptional } from '../../state/ReviewProvider.js';
import { CommentLineRow } from '../Review/CommentLineRow.js';
import type { Highlighter } from './DiffFile.js';

interface Props {
  hunk: Hunk;
  /** Whether this hunk is rendered in review mode (line clicks open composers). */
  review?: boolean;
  /** Required when review is true — used to scope comments and the composer. */
  repo?: string;
  file?: string;
  /** Optional render-time syntax highlighter. When null we render plain text. */
  highlight?: Highlighter | null;
  /** Whether this hunk is checked off as reviewed (review progress state). */
  reviewed?: boolean;
  /** Toggle the reviewed flag. Wired by the parent so it can persist. */
  onToggleReviewed?: (next: boolean) => void;
}

export function DiffHunk({
  hunk,
  review = false,
  repo,
  file,
  highlight,
  reviewed,
  onToggleReviewed,
}: Props) {
  // Intra-line diff computation walks every row pair. Memoize so resizing
  // the sidebar or scrolling doesn't re-run it on each render.
  const rows = useMemo(() => hunkRows(hunk), [hunk]);
  const ctxText = hunk.context ? ' ' + hunk.context : '';
  const showCheckbox = review && !!file && !!onToggleReviewed;
  // Only show the "reviewed" accent in review mode. In read-only views
  // (static `wd` / `wd --server`) there's no checkbox to toggle it off, so a
  // stale localStorage flag must not paint a green row the user can't clear.
  const showReviewedAccent = showCheckbox && !!reviewed;
  return (
    <>
      <tr className={'wd-hunk-row' + (showReviewedAccent ? ' wd-hunk-reviewed' : '')}>
        <td colSpan={4} className="wd-hunk-context">
          {showCheckbox && (
            <label
              className="wd-hunk-checkbox"
              title="Mark this hunk as reviewed"
            >
              <input
                type="checkbox"
                checked={!!reviewed}
                aria-label={`Mark hunk reviewed: ${file} @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                onChange={(e) => onToggleReviewed!(e.target.checked)}
              />
            </label>
          )}
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{' '}
          @@{ctxText}
        </td>
      </tr>
      {rows.map((r) => (
        <Fragment key={`${r.oldNum ?? 'x'}-${r.newNum ?? 'x'}`}>
          <DiffSideRow
            row={r}
            review={review}
            repo={repo}
            file={file}
            highlight={highlight}
          />
          {review && repo && file && (
            <CommentLineRow
              repo={repo}
              file={file}
              oldLine={r.oldNum}
              oldContent={r.oldContent}
              newLine={r.newNum}
              newContent={r.newContent}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}

function DiffSideRow({
  row,
  review,
  repo,
  file,
  highlight,
}: {
  row: SideRow;
  review: boolean;
  repo?: string;
  file?: string;
  highlight?: Highlighter | null;
}) {
  const reviewCtx = useReviewOptional();
  const enabled = review && !!repo && !!file && !!reviewCtx;

  function openComposer(side: 'left' | 'right') {
    if (!enabled || !reviewCtx || !repo || !file) return;
    const line = side === 'left' ? row.oldNum : row.newNum;
    if (line === null) return;
    reviewCtx.openComposerAt({
      repo,
      file,
      line,
      side,
      lineContent: side === 'left' ? row.oldContent : row.newContent,
    });
  }

  return (
    <tr className="wd-row">
      <td
        className={
          `wd-ln wd-ln-old wd-${row.oldKind}` +
          (enabled && row.oldNum !== null ? ' wd-ln-clickable' : '')
        }
        onClick={enabled && row.oldNum !== null ? () => openComposer('left') : undefined}
      >
        {row.oldNum ?? ''}
      </td>
      <ContentCell
        className={`wd-content wd-${row.oldKind}`}
        text={row.oldContent}
        spans={row.oldSpans}
        kind="delete"
        highlight={highlight}
      />
      <td
        className={
          `wd-ln wd-ln-new wd-${row.newKind}` +
          (enabled && row.newNum !== null ? ' wd-ln-clickable' : '')
        }
        onClick={enabled && row.newNum !== null ? () => openComposer('right') : undefined}
      >
        {row.newNum ?? ''}
      </td>
      <ContentCell
        className={`wd-content wd-${row.newKind}`}
        text={row.newContent}
        spans={row.newSpans}
        kind="add"
        highlight={highlight}
      />
    </tr>
  );
}

function ContentCell({
  className,
  text,
  spans,
  kind,
  highlight,
}: {
  className: string;
  text: string;
  spans: IntraSpan[] | undefined;
  kind: 'add' | 'delete';
  highlight?: Highlighter | null;
}) {
  // When the line has word-level diff spans, render those (skip hljs —
  // intra-line markup wins; mirrors GitHub's behaviour).
  if (spans) {
    return (
      <td className={className}>
        {spans.map((s, i) =>
          s.changed ? (
            <span key={i} className={`wd-intra-${kind === 'add' ? 'add' : 'del'}`}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </td>
    );
  }
  const html = highlight ? highlight(text) : null;
  if (html !== null && html !== undefined) {
    return (
      <td
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <td className={className}>{text || ' '}</td>;
}
