import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js';
import type { ParsedFile } from '../../api/client.js';
import { languageForPath } from '../../utils/language.js';
import { STATUS_LETTER } from '../../utils/status.js';
import { Markdown } from '../Markdown.js';
import { DiffHunk } from './DiffHunk.js';
import { GapRegion } from './GapRegion.js';
import { useReviewedHunks } from '../../hooks/use-reviewed-hunks.js';
import { hunkContentKey } from '../../utils/hunk-key.js';
import { computeGaps } from '../../utils/expand.js';
import { hunkHeading } from '../../utils/hunk-heading.js';
import { useExpandOptional } from '../../state/ExpandProvider.js';
import { useReviewOptional, useReview } from '../../state/ReviewProvider.js';
import { CommentItem } from '../Review/CommentItem.js';
import { Composer } from '../Review/Composer.js';

type FileViewMode = 'diff' | 'preview' | 'split';

interface Props {
  file: ParsedFile;
  anchor: string;
  review?: boolean;
  repo?: string;
  /** Whether this file has been marked "viewed" — collapses the diff body. */
  viewed?: boolean;
  /** Toggle the viewed flag. Wired by the parent so it can persist. */
  onToggleViewed?: (next: boolean) => void;
  /** Scope key for per-hunk reviewed state. Empty disables persistence. */
  hunkScopeKey?: string;
}

export type Highlighter = (text: string) => string | null;

/** Lines (added + deleted) past which we don't auto-render the diff
 *  table. The user can click "Load diff" to opt in. Same rationale as
 *  GitHub's "large diffs are not rendered by default" — auto-generated
 *  migrations, lockfile dumps, etc. blow up React reconciliation and
 *  freeze the browser. 500 covers normal files comfortably and traps
 *  the genuine pathology. */
const AUTO_COLLAPSE_LINES = 500;

export function DiffFile({
  file,
  anchor,
  review,
  repo,
  viewed,
  onToggleViewed,
  hunkScopeKey,
}: Props) {
  const { reviewedHunkKeys, toggle: toggleHunk } = useReviewedHunks(
    hunkScopeKey ?? '',
  );
  // Whole-file comments need the review context + a repo name. Suppressed in
  // static / dashboard-readonly mode where no ReviewProvider is mounted.
  const reviewCtx = useReviewOptional();
  const fileCommentsOn = !!review && !!reviewCtx && !!repo;
  // "Open whole file" link. Only when a server-backed expand provider is
  // present (suppressed in static mode) and the working-tree file actually
  // exists — deleted/binary files have nothing to open.
  const expand = useExpandOptional();
  // When an expand provider is mounted, gaps render an expander bar that
  // carries the below-hunk context; without one (static mode) each hunk
  // falls back to showing its own context label.
  const canExpand = !!expand;
  const openFileHref =
    expand && repo && !file.isBinary && file.status !== 'deleted'
      ? expand.fileHref(repo, file.path)
      : null;
  // Stable, render-time highlighter. We highlight the full line text on
  // demand; cells with intra-line spans skip this path (the word-diff
  // markup wins). React owns the DOM via dangerouslySetInnerHTML — no
  // post-paint mutation, no reuse-across-renders staleness.
  const highlight = useMemo<Highlighter | null>(() => {
    if (file.isBinary) return null;
    const lang = languageForPath(file.path);
    if (!lang || !hljs.getLanguage(lang)) return null;
    return (text: string) => {
      if (!text.trim()) return null;
      try {
        return hljs.highlight(text, { language: lang, ignoreIllegals: true })
          .value;
      } catch {
        return null;
      }
    };
  }, [file.isBinary, file.path]);

  // Large-file gate. Auto-generated migrations / lockfile churn / bundle
  // diffs can have tens of thousands of rows; rendering them all at once
  // blocks the main thread for seconds. Default to a placeholder; user
  // clicks "Load diff" to opt in (per-file, in-component state — resets
  // on scope switch which is the right reset point).
  const totalChanged = file.added + file.deleted;
  const isLarge = totalChanged >= AUTO_COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(!isLarge);

  // GitHub-style per-file fold. The chevron in the header collapses the
  // whole file body. A file starts folded when it carries no diff worth
  // reading — a deletion, or a rename with no content change — or when
  // it's marked "viewed" (GitHub parity). The chevron overrides this
  // freely; the default only re-applies when one of its inputs changes
  // (viewed toggles, or live-reload flips the file's status/hunks).
  // Ephemeral (resets on scope switch), same as the large-file `expanded`
  // gate above.
  const isPureRename = file.status === 'renamed' && file.hunks.length === 0;
  const autoCollapsed = !!viewed || file.status === 'deleted' || isPureRename;
  const [collapsed, setCollapsed] = useState<boolean>(autoCollapsed);
  useEffect(() => {
    setCollapsed(autoCollapsed);
  }, [autoCollapsed]);

  // Per-file view mode. Markdown files get a Diff | Preview | Split toggle —
  // Preview renders the new (or before, for deletions) content; Split shows
  // both rendered side-by-side. Non-markdown files always render the diff.
  // Server may also flag `tooLarge: true` to opt the file out of preview
  // when content would balloon the payload (large auto-generated docs).
  const mdContent = file.mdContent;
  const hasPreview =
    !!mdContent &&
    !mdContent.tooLarge &&
    (mdContent.before !== undefined || mdContent.after !== undefined);
  const hasSplit =
    !!mdContent &&
    !mdContent.tooLarge &&
    mdContent.before !== undefined &&
    mdContent.after !== undefined;
  const [viewMode, setViewMode] = useState<FileViewMode>('diff');
  // Reset to the diff view whenever the file folds. The body gate is
  // `!collapsed` (not `!viewed`), so without this an expand of a
  // previously-Preview'd file would re-open straight into the rendered
  // preview rather than the diff. GitHub always re-expands to the diff.
  useEffect(() => {
    if (collapsed) setViewMode('diff');
  }, [collapsed]);

  // Expandable unchanged regions (head / between-hunks / tail). Computed
  // from the hunks alone — independent of `repo` so the header-hiding
  // logic below is correct even when no expand provider is mounted. The
  // GapRegion render sites gate on `repo` separately.
  const gapByKey = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeGaps>[number]>();
    for (const g of computeGaps(file.hunks)) m.set(g.key, g);
    return m;
  }, [file.hunks]);

  // Gaps that have been fully expanded — their `@@` divider on the hunk
  // below is then redundant and gets suppressed. Stable per-gap handlers
  // keep GapRegion's notify-effect from firing every render.
  const [closedGaps, setClosedGaps] = useState<Set<string>>(() => new Set());
  const setGapClosed = useCallback((key: string, isClosed: boolean) => {
    setClosedGaps((prev) => {
      if (isClosed === prev.has(key)) return prev;
      const next = new Set(prev);
      if (isClosed) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const gapHandlers = useMemo(() => {
    const m = new Map<string, (closed: boolean) => void>();
    for (const key of gapByKey.keys()) {
      m.set(key, (closed: boolean) => setGapClosed(key, closed));
    }
    return m;
  }, [gapByKey, setGapClosed]);

  const renamed =
    file.status === 'renamed' && file.oldPath !== file.newPath ? (
      <span className="wd-rename">
        {file.oldPath} → {file.newPath}
      </span>
    ) : null;
  return (
    <article
      className={
        'wd-file' +
        (viewed ? ' wd-file-viewed' : '') +
        (collapsed ? ' wd-file-collapsed' : '')
      }
      id={anchor}
      data-status={file.status}
      data-path={file.path}
    >
      <header className="wd-file-header">
        <button
          type="button"
          className="wd-file-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand file' : 'Collapse file'}
          title={collapsed ? 'Expand file' : 'Collapse file'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="wd-chevron" aria-hidden="true">
            ▸
          </span>
        </button>
        <span className={`wd-file-badge wd-status-${file.status}`}>
          {STATUS_LETTER[file.status]}
        </span>
        <span className="wd-file-path">{renamed ?? file.path}</span>
        {(file.added || file.deleted) && (
          <span className="wd-file-stats">
            <span className="wd-add">+{file.added}</span>{' '}
            <span className="wd-del">-{file.deleted}</span>
          </span>
        )}
        {hasPreview && !collapsed && (
          <div
            className="wd-view-mode"
            role="tablist"
            aria-label="File view mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'diff'}
              className={
                'wd-view-mode-btn' +
                (viewMode === 'diff' ? ' wd-view-mode-btn-active' : '')
              }
              onClick={() => setViewMode('diff')}
            >
              Diff
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'preview'}
              className={
                'wd-view-mode-btn' +
                (viewMode === 'preview' ? ' wd-view-mode-btn-active' : '')
              }
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            {hasSplit && (
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'split'}
                className={
                  'wd-view-mode-btn' +
                  (viewMode === 'split' ? ' wd-view-mode-btn-active' : '')
                }
                onClick={() => setViewMode('split')}
              >
                Split
              </button>
            )}
          </div>
        )}
        {openFileHref && (
          <a
            className="wd-file-openfile"
            href={openFileHref}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the whole file in a new tab"
          >
            Open file ↗
          </a>
        )}
        {fileCommentsOn && (
          <button
            type="button"
            className="wd-file-comment-btn"
            title="Comment on the whole file"
            onClick={() =>
              reviewCtx!.openComposerAt({
                repo: repo!,
                file: file.path,
                line: 0,
                side: 'file',
                lineContent: '',
              })
            }
          >
            💬 Comment on file
          </button>
        )}
        {onToggleViewed && (
          <label
            className="wd-viewed-label"
            title="Mark this file as reviewed and collapse it"
          >
            <input
              type="checkbox"
              className="wd-viewed-checkbox"
              checked={!!viewed}
              onChange={(e) => onToggleViewed(e.target.checked)}
            />
            Viewed
          </label>
        )}
      </header>
      {fileCommentsOn && <FileCommentSection repo={repo!} file={file.path} />}
      {!collapsed &&
        (hasPreview && viewMode !== 'diff' ? (
          <MarkdownPreview file={file} mode={viewMode} />
        ) : file.isBinary ? (
          <div className="wd-binary">Binary file</div>
        ) : file.hunks.length === 0 ? (
          <div className="wd-binary">
            {isPureRename ? 'File renamed without changes' : 'No content changes'}
          </div>
        ) : !expanded ? (
          <div className="wd-binary wd-large-file">
            <p>
              Large file — {totalChanged.toLocaleString()} line
              {totalChanged === 1 ? '' : 's'} changed. Not rendered by
              default.
            </p>
            <button
              type="button"
              className="wd-btn-secondary"
              onClick={() => setExpanded(true)}
            >
              Load diff
            </button>
          </div>
        ) : (
          <table className="wd-diff-table wd-side">
            <colgroup>
              <col className="wd-col-ln" />
              <col className="wd-col-content" />
              <col className="wd-col-ln" />
              <col className="wd-col-content" />
            </colgroup>
            <tbody>
              {repo && gapByKey.has('head') && (
                <GapRegion
                  repo={repo}
                  file={file.path}
                  gap={gapByKey.get('head')!}
                  highlight={highlight}
                  onClosedChange={gapHandlers.get('head')}
                  belowHeading={file.hunks[0] ? hunkHeading(file.hunks[0]) : undefined}
                />
              )}
              {file.hunks.map((h, i) => {
                // Content-derived key: stable across chokidar live-reload
                // even when unrelated edits shift this hunk's line numbers,
                // so the "reviewed" checkmark stays glued to the change.
                const hunkKey = hunkContentKey(file.path, h);
                const midGap = gapByKey.get(`mid-${i}`);
                // Decide whether THIS hunk renders its own `@@ … @@` heading.
                // It doesn't when the heading is already carried by the
                // expander bar of the gap above (GitHub single-bar), nor when
                // the lines above are contiguous (gap fully expanded, or
                // adjacent to the previous hunk). When no expand provider is
                // mounted (static mode) the gap has no bar, so the hunk shows
                // its own heading as a fallback.
                const gapAboveKey = i === 0 ? 'head' : `mid-${i - 1}`;
                const hasGapAbove = gapByKey.has(gapAboveKey);
                const gapAboveClosed = closedGaps.has(gapAboveKey);
                const barAboveShowsHeading =
                  canExpand && hasGapAbove && !gapAboveClosed;
                const contiguousAbove =
                  gapAboveClosed || (!hasGapAbove && i > 0);
                const showOwnHeading = !barAboveShowsHeading && !contiguousAbove;
                return (
                  // Suffix the array index so two byte-identical hunks in
                  // the same file (same content hash) still get distinct
                  // React keys.
                  <Fragment key={`${hunkKey}#${i}`}>
                    <DiffHunk
                      hunk={h}
                      review={review}
                      repo={repo}
                      file={file.path}
                      highlight={highlight}
                      reviewed={reviewedHunkKeys.has(hunkKey)}
                      onToggleReviewed={
                        hunkScopeKey
                          ? (next: boolean) => toggleHunk(hunkKey, next)
                          : undefined
                      }
                      showHeading={showOwnHeading}
                    />
                    {repo && midGap && (
                      <GapRegion
                        repo={repo}
                        file={file.path}
                        gap={midGap}
                        highlight={highlight}
                        onClosedChange={gapHandlers.get(`mid-${i}`)}
                        belowHeading={
                          file.hunks[i + 1]
                            ? hunkHeading(file.hunks[i + 1])
                            : undefined
                        }
                      />
                    )}
                  </Fragment>
                );
              })}
              {repo && gapByKey.has('tail') && (
                <GapRegion
                  repo={repo}
                  file={file.path}
                  gap={gapByKey.get('tail')!}
                  highlight={highlight}
                />
              )}
            </tbody>
          </table>
        ))}
    </article>
  );
}

/**
 * Whole-file (GitHub-style) comments, rendered between the file header and
 * its diff body. Lists the file-level thread(s) and shows the composer when
 * the user has opened it via the header's "Comment on file" button. Only
 * mounted when a ReviewProvider is present (see `fileCommentsOn`).
 */
function FileCommentSection({ repo, file }: { repo: string; file: string }) {
  const review = useReview();
  const comments = review.comments.filter(
    (c) => c.side === 'file' && !c.parentId && c.repo === repo && c.file === file,
  );
  const composerOpen =
    review.openComposer !== null &&
    review.openComposer.side === 'file' &&
    review.openComposer.repo === repo &&
    review.openComposer.file === file;

  if (comments.length === 0 && !composerOpen) return null;

  return (
    <div className="wd-file-comments">
      {comments.map((c) => (
        <CommentItem key={c.id} comment={c} currentLineContent={null} />
      ))}
      {composerOpen && (
        <Composer
          context={`${repo}/${file} · whole file`}
          onSubmit={async (body, status) => {
            await review.postComment({
              repo,
              file,
              line: 0,
              side: 'file',
              body,
              status,
            });
            review.closeComposer();
          }}
          onCancel={() => review.closeComposer()}
        />
      )}
    </div>
  );
}

interface MarkdownPreviewProps {
  file: ParsedFile;
  mode: FileViewMode;
}

/**
 * Rendered preview for markdown files. `preview` shows the after-content
 * (or before for deletions), `split` shows both sides side-by-side. The
 * source strings are pre-fetched by the diff pipeline; this component is
 * pure rendering.
 */
function MarkdownPreview({ file, mode }: MarkdownPreviewProps) {
  const md = file.mdContent!;
  if (mode === 'split' && md.before !== undefined && md.after !== undefined) {
    return (
      <div className="wd-md-split">
        <div className="wd-md-split-side wd-md-split-before">
          <header className="wd-md-split-label">Before</header>
          <Markdown source={md.before} block className="wd-md-preview" />
        </div>
        <div className="wd-md-split-side wd-md-split-after">
          <header className="wd-md-split-label">After</header>
          <Markdown source={md.after} block className="wd-md-preview" />
        </div>
      </div>
    );
  }
  // Preview mode: prefer after-content (the new version). Falls back to
  // before for deleted files where only the old version exists.
  const source = md.after ?? md.before ?? '';
  return <Markdown source={source} block className="wd-md-preview" />;
}
