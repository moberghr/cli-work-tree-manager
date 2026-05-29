import { Fragment } from 'react';
import type { Hunk } from '../../api/client.js';
import {
  hunkRows,
  type IntraSpan,
  type SideRow,
} from '../../utils/intraline.js';
import { useReviewOptional } from '../../state/ReviewProvider.js';
import { CommentLineRow } from '../Review/CommentLineRow.js';

interface Props {
  hunk: Hunk;
  /** Whether this hunk is rendered in review mode (line clicks open composers). */
  review?: boolean;
  /** Required when review is true — used to scope comments and the composer. */
  repo?: string;
  file?: string;
}

export function DiffHunk({ hunk, review = false, repo, file }: Props) {
  const rows = hunkRows(hunk);
  const ctxText = hunk.context ? ' ' + hunk.context : '';
  return (
    <>
      <tr className="wd-hunk-row">
        <td colSpan={4} className="wd-hunk-context">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{' '}
          @@{ctxText}
        </td>
      </tr>
      {rows.map((r, i) => (
        <Fragment key={i}>
          <DiffSideRow row={r} review={review} repo={repo} file={file} />
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
}: {
  row: SideRow;
  review: boolean;
  repo?: string;
  file?: string;
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
      <td className={`wd-content wd-${row.oldKind}`}>
        <ContentCell text={row.oldContent} spans={row.oldSpans} kind="delete" />
      </td>
      <td
        className={
          `wd-ln wd-ln-new wd-${row.newKind}` +
          (enabled && row.newNum !== null ? ' wd-ln-clickable' : '')
        }
        onClick={enabled && row.newNum !== null ? () => openComposer('right') : undefined}
      >
        {row.newNum ?? ''}
      </td>
      <td className={`wd-content wd-${row.newKind}`}>
        <ContentCell text={row.newContent} spans={row.newSpans} kind="add" />
      </td>
    </tr>
  );
}

function ContentCell({
  text,
  spans,
  kind,
}: {
  text: string;
  spans: IntraSpan[] | undefined;
  kind: 'add' | 'delete';
}) {
  if (spans) {
    return (
      <>
        {spans.map((s, i) =>
          s.changed ? (
            <span key={i} className={`wd-intra-${kind === 'add' ? 'add' : 'del'}`}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </>
    );
  }
  return <>{text || ' '}</>;
}
