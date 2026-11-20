import { Fragment, useMemo, useState } from 'react';
import type { ParsedFile } from '../../api/client.js';
import { addedLines } from '../../utils/intraline.js';
import { highlightBlock } from '../../utils/highlight.js';
import { selectCommentsForLine, useReviewOptional } from '../../state/ReviewProvider.js';
import { SidePanel, type SideContent } from '../Review/CommentLineRow.js';
import { leadingImports } from '../../state/import-fold.js';
import { hostThreadsAt, useHostThreads } from '../../state/HostThreads.js';

interface Props {
  file: ParsedFile;
  /** Resolved hljs language for this file, or null to render plain text. */
  lang?: string | null;
  /** Whether this file is rendered in review mode (line clicks open composers). */
  review?: boolean;
  /** Required when review is true — used to scope comments and the composer. */
  repo?: string;
  /** Fold the block of import lines it starts with into one row (a review: nobody reads them). */
  foldImports?: boolean;
}

/**
 * Full-width single-column renderer for an added (brand-new) file. The
 * side-by-side diff table wastes half its width on an empty "old" column for
 * new files, so here we drop the old side entirely and render the new content
 * across the full width, keeping the green `wd-add` tint so it still reads as
 * an all-new diff.
 *
 * Highlighting matches the rest of the viewer: the whole file is highlighted
 * as one contiguous block (`highlightBlock`) so stateful grammars keep context
 * across lines, then indexed per line. Review-mode line comments work the same
 * as the side-by-side view — clicking a line number opens the composer on the
 * `right` side, and threads render inline below their line.
 */
export function NewFileView({ file, lang, review = false, repo, foldImports = false }: Props) {
  const rows = useMemo(() => addedLines(file.hunks), [file.hunks]);
  const reviewCtx = useReviewOptional();
  const host = useHostThreads();
  const [importsOpen, setImportsOpen] = useState(false);
  const block = useMemo(() => (foldImports ? leadingImports(rows.map((r) => r.content)) : null), [foldImports, rows]);
  // A comment on one of its lines keeps the block open: a folded comment would be one nobody reads.
  const commented =
    !!block &&
    (!!reviewCtx?.comments.some(
      (c) => c.file === file.path && c.line >= rows[block.first].newNum && c.line <= rows[block.last].newNum && (!repo || c.repo === repo),
    ) ||
      rows.slice(block.first, block.last + 1).some((r) => hostThreadsAt(host, file.path, 'right', r.newNum).length > 0));
  const fold = block && !commented && !importsOpen ? block : null;
  const html = useMemo(
    () =>
      lang
        ? highlightBlock(
            rows.map((r) => r.content),
            lang,
          )
        : null,
    [rows, lang],
  );
  return (
    <table className="wd-diff-table wd-newfile">
      <colgroup>
        <col className="wd-col-ln" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((r, i) =>
          fold && i >= fold.first && i <= fold.last ? (
            i === fold.first ? (
              <tr key="imports" className="wd-row wd-import-fold">
                <td className="wd-ln" />
                <td className="wd-content">
                  <button type="button" className="wd-link-button" onClick={() => setImportsOpen(true)} aria-expanded={false}>
                    {fold.count} import lines ▸
                  </button>
                </td>
              </tr>
            ) : null
          ) : (
            <Fragment key={r.newNum}>
              <NewFileRow line={r.newNum} content={r.content} html={html?.[i] ?? null} review={review} repo={repo} file={file.path} />
              {review && repo && <NewFileCommentRow repo={repo} file={file.path} line={r.newNum} content={r.content} />}
            </Fragment>
          ),
        )}
      </tbody>
    </table>
  );
}

function NewFileRow({
  line,
  content,
  html,
  review,
  repo,
  file,
}: {
  line: number;
  content: string;
  html: string | null;
  review: boolean;
  repo?: string;
  file: string;
}) {
  const reviewCtx = useReviewOptional();
  const enabled = review && !!repo && !!reviewCtx;

  function openComposer() {
    if (!enabled || !reviewCtx || !repo) return;
    reviewCtx.openComposerAt({
      repo,
      file,
      line,
      side: 'right',
      lineContent: content,
    });
  }

  return (
    <tr className="wd-row">
      <td className={'wd-ln wd-ln-new wd-add' + (enabled ? ' wd-ln-clickable' : '')} onClick={enabled ? openComposer : undefined}>
        {line}
      </td>
      {html !== null ? (
        <td className="wd-content wd-add" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <td className="wd-content wd-add">{content || ' '}</td>
      )}
    </tr>
  );
}

/**
 * Inline comment thread + composer for a single new-file line. Mirrors the
 * right side of `CommentLineRow`, but as a single full-width cell to match the
 * two-column new-file table. Renders nothing unless the line has activity.
 */
function NewFileCommentRow({ repo, file, line, content }: { repo: string; file: string; line: number; content: string }) {
  const reviewCtx = useReviewOptional();
  const host = useHostThreads();
  if (!reviewCtx) return null;

  const side: SideContent = {
    comments: selectCommentsForLine(reviewCtx.comments, repo, file, line, 'right'),
    hostThreads: hostThreadsAt(host, file, 'right', line),
    composerOpen:
      reviewCtx.openComposer !== null &&
      reviewCtx.openComposer.repo === repo &&
      reviewCtx.openComposer.file === file &&
      reviewCtx.openComposer.line === line &&
      reviewCtx.openComposer.side === 'right',
    lineContent: content,
    line,
    side: 'right',
  };

  if (side.comments.length === 0 && !side.hostThreads?.length && !side.composerOpen) return null;

  return (
    <tr className="wd-comment-row">
      <td colSpan={2} className="wd-comment-side">
        <SidePanel repo={repo} file={file} side={side} />
      </td>
    </tr>
  );
}
