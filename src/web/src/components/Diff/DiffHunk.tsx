import { Fragment, useMemo } from 'react';
import type { Hunk } from '../../api/client.js';
import { hunkRows, inlineRows, type InlineRow, type IntraSpan, type SideRow } from '../../utils/intraline.js';
import { useReviewOptional } from '../../state/ReviewProvider.js';
import { useDiffMode } from '../../state/DiffModeProvider.js';
import { CommentLineRow, InlineCommentRow } from '../Review/CommentLineRow.js';
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
 * old vs new side.
 *
 * `context` (the file's newer side, from its first line: FileContext, read
 * by DiffFile) is what's ABOVE the hunk: a hunk starting inside a raw string,
 * a `/*` comment or a Razor `@code {` was highlighted from the middle — the
 * closing `"""` read as an opening one, and the rest of the hunk coloured as
 * a string (reported, twice). With it, the newer side's lines come from the
 * whole file highlighted once, and the older side's are highlighted after the
 * lines above the hunk (the newer side's: the same text but for earlier
 * hunks). Without it (static mode, a file too big): the hunk alone, as before.
 */
export function buildHunkHighlight(hunk: Hunk, lang: string | null | undefined, context?: FileContext | null): HunkLineHtml | null {
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
  const toMap = (rows: { num: number; content: string }[], before: string[] = []): Map<number, string> => {
    const html = highlightBlock([...before, ...rows.map((r) => r.content)], lang).slice(before.length);
    const m = new Map<number, string>();
    rows.forEach((r, i) => {
      const h = html[i];
      if (h) m.set(r.num, h);
    });
    return m;
  };
  if (context && context.lang === lang && newRows.every((r) => context.lines[r.num - 1] === r.content)) {
    const neu = new Map<number, string>();
    for (const r of newRows) {
      const h = context.html[r.num - 1];
      if (h) neu.set(r.num, h);
    }
    return { old: oldRows.length ? toMap(oldRows, context.lines.slice(0, Math.max(0, hunk.newStart - 1))) : new Map(), new: neu };
  }
  return { old: toMap(oldRows), new: toMap(newRows) };
}

/** The file's newer side from its first line, and that text highlighted as one block (DiffFile's useFileContext). */
export interface FileContext {
  lang: string;
  lines: string[];
  html: (string | null)[];
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
  /** The file's newer side, for a hunk that starts inside a string or comment (null: the hunk alone). */
  context?: FileContext | null;
  /** Whether this hunk renders its own `@@ … @@` heading row. The parent
   *  sets this false when the heading is already shown on the expander bar
   *  of the gap directly above (GitHub-style single bar), or when the lines
   *  above are contiguous (gap fully expanded / adjacent hunk). Defaults to
   *  true. */
  showHeading?: boolean;
}

export function DiffHunk({ hunk, review = false, repo, file, lang, context = null, showHeading = true }: Props) {
  const mode = useDiffMode();
  // Intra-line diff computation walks every row pair. Memoize so resizing
  // the sidebar or scrolling doesn't re-run it on each render.
  const rows = useMemo(() => hunkRows(hunk), [hunk]);
  const iRows = useMemo(() => (mode === 'unified' ? inlineRows(hunk) : []), [hunk, mode]);
  // Highlight both sides of the hunk as contiguous blocks (preserves
  // multi-line grammar state), keyed by line number for per-cell lookup.
  const lineHtml = useMemo(() => buildHunkHighlight(hunk, lang, context), [hunk, lang, context]);
  // The unified table has 3 columns (old-ln, new-ln, content); the split
  // table has 4 (old-ln, old-content, new-ln, new-content). The hunk
  // heading row spans them all.
  const headerColSpan = mode === 'unified' ? 3 : 4;
  // The full `@@ -a,b +c,d @@ <context>` heading, like GitHub. The parent
  // suppresses it (`showHeading=false`) when the gap's expander bar above
  // already shows it, or when the lines above are contiguous. Nothing else
  // goes on it: a hunk is reviewed and reverted with its file (Viewed, Revert
  // file), as on GitHub.
  return (
    <>
      {showHeading && (
        <tr className="wd-hunk-row">
          <td colSpan={headerColSpan} className="wd-hunk-context">
            {hunkHeading(hunk)}
          </td>
        </tr>
      )}
      {mode === 'unified'
        ? iRows.map((r, i) => (
            <Fragment key={`${r.kind}-${r.oldNum ?? 'x'}-${r.newNum ?? 'x'}-${i}`}>
              <DiffInlineRow row={r} review={review} repo={repo} file={file} lineHtml={lineHtml} />
              {review && repo && file && <InlineCommentForRow row={r} repo={repo} file={file} />}
            </Fragment>
          ))
        : rows.map((r) => (
            <Fragment key={`${r.oldNum ?? 'x'}-${r.newNum ?? 'x'}`}>
              <DiffSideRow row={r} review={review} repo={repo} file={file} lineHtml={lineHtml} />
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

/** An inline row's comment side: a deletion comments on the old (left) line,
 *  an addition or context line on the new (right) line. */
function InlineCommentForRow({ row, repo, file }: { row: InlineRow; repo: string; file: string }) {
  const side: 'left' | 'right' = row.kind === 'delete' ? 'left' : 'right';
  const line = side === 'left' ? row.oldNum : row.newNum;
  if (line === null) return null;
  return <InlineCommentRow repo={repo} file={file} line={line} side={side} content={row.content} />;
}

/** One unified-layout row: a single content cell preceded by both line-number
 *  gutters (old then new). Deletions show the old number only, additions the
 *  new number only, context lines both. The whole row is tinted by kind. */
function DiffInlineRow({
  row,
  review,
  repo,
  file,
  lineHtml,
}: {
  row: InlineRow;
  review: boolean;
  repo?: string;
  file?: string;
  lineHtml: HunkLineHtml | null;
}) {
  const reviewCtx = useReviewOptional();
  const enabled = review && !!repo && !!file && !!reviewCtx;
  const side: 'left' | 'right' = row.kind === 'delete' ? 'left' : 'right';
  const commentLine = side === 'left' ? row.oldNum : row.newNum;
  const clickable = enabled && commentLine !== null;

  function openComposer() {
    if (!enabled || !reviewCtx || !repo || !file || commentLine === null) return;
    reviewCtx.openComposerAt({
      repo,
      file,
      line: commentLine,
      side,
      lineContent: row.content,
    });
  }

  // Highlight lookup mirrors the split view, keyed off the side the row
  // anchors to: a deletion (left) reads the old-side map by oldNum, an
  // addition/context (right) the new-side map by newNum.
  const html =
    side === 'left'
      ? row.oldNum !== null
        ? (lineHtml?.old.get(row.oldNum) ?? null)
        : null
      : row.newNum !== null
        ? (lineHtml?.new.get(row.newNum) ?? null)
        : null;

  // `wd-add`/`wd-delete`/`wd-context` tint the whole row; the intra-line
  // markup (when present) wins over hljs, same as the split ContentCell.
  const kindClass = row.kind === 'add' ? 'wd-add' : row.kind === 'delete' ? 'wd-delete' : 'wd-context';

  return (
    <tr className="wd-row">
      <LnCell num={row.oldNum} side="old" kindClass={kindClass} clickable={clickable && side === 'left'} onClick={openComposer} />
      <LnCell num={row.newNum} side="new" kindClass={kindClass} clickable={clickable && side === 'right'} onClick={openComposer} />
      <ContentCell className={`wd-content ${kindClass}`} text={row.content} spans={row.spans} kind={row.kind} html={html} />
    </tr>
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
      <LnCell
        num={row.oldNum}
        side="old"
        kindClass={`wd-${row.oldKind}`}
        clickable={enabled && row.oldNum !== null}
        onClick={() => openComposer('left')}
      />
      <ContentCell
        className={`wd-content wd-${row.oldKind}`}
        text={row.oldContent}
        spans={row.oldSpans}
        kind="delete"
        html={row.oldNum !== null ? (lineHtml?.old.get(row.oldNum) ?? null) : null}
      />
      <LnCell
        num={row.newNum}
        side="new"
        kindClass={`wd-${row.newKind}`}
        clickable={enabled && row.newNum !== null}
        onClick={() => openComposer('right')}
      />
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

/** One line-number gutter cell, shared by the split and unified rows. `side`
 *  picks the `wd-ln-old`/`wd-ln-new` class; `kindClass` is the per-cell tint
 *  (`wd-delete`/`wd-add`/`wd-context`). Clickable cells open the composer. */
function LnCell({
  num,
  side,
  kindClass,
  clickable,
  onClick,
}: {
  num: number | null;
  side: 'old' | 'new';
  kindClass: string;
  clickable: boolean;
  onClick: () => void;
}) {
  return (
    <td className={`wd-ln wd-ln-${side} ${kindClass}` + (clickable ? ' wd-ln-clickable' : '')} onClick={clickable ? onClick : undefined}>
      {num ?? ''}
    </td>
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
  // 'context' only arises in the unified layout; context lines never carry
  // intra-line spans, so it falls through to the 'del' span class harmlessly.
  kind: 'context' | 'add' | 'delete';
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
    return <td className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <td className={className}>{text || ' '}</td>;
}
