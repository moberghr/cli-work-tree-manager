import { useMemo, useState } from 'react';
import hljs from 'highlight.js';
import type { ParsedFile } from '../../api/client.js';
import { languageForPath } from '../../utils/language.js';
import { STATUS_LETTER } from '../../utils/status.js';
import { Markdown } from '../Markdown.js';
import { DiffHunk } from './DiffHunk.js';

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
}: Props) {
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

  const renamed =
    file.status === 'renamed' && file.oldPath !== file.newPath ? (
      <span className="wd-rename">
        {file.oldPath} → {file.newPath}
      </span>
    ) : null;
  return (
    <article
      className={'wd-file' + (viewed ? ' wd-file-viewed' : '')}
      id={anchor}
      data-status={file.status}
      data-path={file.path}
    >
      <header className="wd-file-header">
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
        {hasPreview && !viewed && (
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
      {!viewed &&
        (hasPreview && viewMode !== 'diff' ? (
          <MarkdownPreview file={file} mode={viewMode} />
        ) : file.isBinary ? (
          <div className="wd-binary">Binary file</div>
        ) : file.hunks.length === 0 ? (
          <div className="wd-binary">No content changes</div>
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
              {file.hunks.map((h) => (
                <DiffHunk
                  hunk={h}
                  key={`${h.oldStart}-${h.newStart}`}
                  review={review}
                  repo={repo}
                  file={file.path}
                  highlight={highlight}
                />
              ))}
            </tbody>
          </table>
        ))}
    </article>
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
