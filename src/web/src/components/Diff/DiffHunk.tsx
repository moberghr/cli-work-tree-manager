import { Fragment, useMemo } from 'react';
import type { Hunk } from '../../api/client.js';
import {
  hunkRows,
  type IntraSpan,
  type SideRow,
} from '../../utils/intraline.js';
import { useReviewOptional } from '../../state/ReviewProvider.js';
import { CommentLineRow } from '../Review/CommentLineRow.js';
import { hunkHeading } from '../../utils/hunk-heading.js';
import { highlightBlock } from '../../utils/highlight.js';

/** Per-side maps from a line number to its pre-highlighted HTML for one hunk. */
interface HunkLineHtml {
  old: Map<number, string>;
  new: Map<number, string>;
}

/**
 * Highlight each side of a hunk as a contiguous block, then index the result
 * by line number. Highlighting the whole side at once (rather than line by
 * line) is what lets a stateful grammar — e.g. Razor's `@code { … }` C#
 * sublanguage, or a multi-line comment/string — keep its context across lines.
 * Returns null when there's no language to highlight with.
 *
 * Each side is highlighted in isolation, so context lines are (intentionally)
 * highlighted on both sides — they can sit in different grammar state on the
 * old vs new side. Limitation: a hunk is highlighted on its own, so when a
 * stateful opener (an `@code {`, a `/*`, a backtick) lives in elided context
 * ABOVE the hunk, that hunk renders unhighlighted — the opener isn't in the
 * block. "Open file ↗" (FileApp) highlights the whole file and is the escape
 * hatch; widening this would mean fetching full-file context per hunk.
 */
function buildHunkHighlight(
  hunk: Hunk,
  lang: string | null | undefined,
): HunkLineHtml | null {
  if (!lang) return null;
  const oldRows: { num: number; content: string }[] = [];
  const newRows: { num: number; content: string }[] = [];
  for (const ln of hunk.lines) {
    if ((ln.kind === 'context' || ln.kind === 'delete') && ln.oldNum !== null) {
      oldRows.push({ num: ln.oldNum, content: ln.content });
    }
    if ((ln.kind === 'context' || ln.kind === 'add') && ln.newNum !== null) {
      newRows.push({ num: ln.newNum, content: ln.content });
    }
  }
  const toMap = (rows: { num: number; content: string }[]): Map<number, string> => {
    const html = highlightBlock(rows.map((r) => r.content), lang);
    const m = new Map<number, string>();
    rows.forEach((r, i) => {
      const h = html[i];
      if (h) m.set(r.num, h);
    });
    return m;
  };
  return { old: toMap(oldRows), new: toMap(newRows) };
}

interface Props {
  hunk: Hunk;
  /** Whether this hunk is rendered in review mode (line clicks open composers). */
  review?: boolean;
  /** Required when review is true — used to scope comments and the composer. */
  repo?: string;
  file?: string;
  /** Resolved hljs language for this file, or null to render plain text. */
  lang?: string | null;
  /** Whether this hunk is checked off as reviewed (review progress state). */
  reviewed?: boolean;
  /** Toggle the reviewed flag. Wired by the parent so it can persist. */
  onToggleReviewed?: (next: boolean) => void;
  /** Whether this hunk renders its own `@@ … @@` heading row. The parent
   *  sets this false when the heading is already shown on the expander bar
   *  of the gap directly above (GitHub-style single bar), or when the lines
   *  above are contiguous (gap fully expanded / adjacent hunk). Defaults to
   *  true. The review checkbox, when present, is shown regardless. */
  showHeading?: boolean;
}

export function DiffHunk({
  hunk,
  review = false,
  repo,
  file,
  lang,
  reviewed,
  onToggleReviewed,
  showHeading = true,
}: Props) {
  // Intra-line diff computation walks every row pair. Memoize so resizing
  // the sidebar or scrolling doesn't re-run it on each render.
  const rows = useMemo(() => hunkRows(hunk), [hunk]);
  // Highlight both sides of the hunk as contiguous blocks (preserves
  // multi-line grammar state), keyed by line number for per-cell lookup.
  const lineHtml = useMemo(() => buildHunkHighlight(hunk, lang), [hunk, lang]);
  const showCheckbox = review && !!file && !!onToggleReviewed;
  // Only show the "reviewed" accent in review mode. In read-only views
  // (static `wd` / `wd --server`) there's no checkbox to toggle it off, so a
  // stale localStorage flag must not paint a green row the user can't clear.
  const showReviewedAccent = showCheckbox && !!reviewed;
  // The full `@@ -a,b +c,d @@ <context>` heading, like GitHub. The parent
  // suppresses it (`showHeading=false`) when the gap's expander bar above
  // already shows it, or when the lines above are contiguous.
  const showHeadingText = showHeading;
  // Render the row when it carries something: the heading, or the review
  // checkbox (which has nowhere else to live).
  const showHeaderRow = showHeadingText || showCheckbox;
  return (
    <>
      {showHeaderRow && (
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
                  aria-label={`Mark hunk reviewed: ${file} lines ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`}
                  onChange={(e) => onToggleReviewed!(e.target.checked)}
                />
              </label>
            )}
            {showHeadingText && hunkHeading(hunk)}
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <Fragment key={`${r.oldNum ?? 'x'}-${r.newNum ?? 'x'}`}>
          <DiffSideRow
            row={r}
            review={review}
            repo={repo}
            file={file}
            lineHtml={lineHtml}
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
  lineHtml,
}: {
  row: SideRow;
  review: boolean;
  repo?: string;
  file?: string;
  lineHtml: HunkLineHtml | null;
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
        html={row.oldNum !== null ? (lineHtml?.old.get(row.oldNum) ?? null) : null}
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
        html={row.newNum !== null ? (lineHtml?.new.get(row.newNum) ?? null) : null}
      />
    </tr>
  );
}

function ContentCell({
  className,
  text,
  spans,
  kind,
  html,
}: {
  className: string;
  text: string;
  spans: IntraSpan[] | undefined;
  kind: 'add' | 'delete';
  html: string | null;
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
  if (html !== null) {
    return (
      <td
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <td className={className}>{text || ' '}</td>;
}
