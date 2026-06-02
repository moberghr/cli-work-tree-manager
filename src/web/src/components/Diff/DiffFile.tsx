import { useMemo, useState } from 'react';
import hljs from 'highlight.js';
import type { ParsedFile } from '../../api/client.js';
import { languageForPath } from '../../utils/language.js';
import { STATUS_LETTER } from '../../utils/status.js';
import { DiffHunk } from './DiffHunk.js';
import { useSelectedHunks } from '../../hooks/use-selected-hunks.js';

interface Props {
  file: ParsedFile;
  anchor: string;
  review?: boolean;
  repo?: string;
  /** Whether this file has been marked "viewed" — collapses the diff body. */
  viewed?: boolean;
  /** Toggle the viewed flag. Wired by the parent so it can persist. */
  onToggleViewed?: (next: boolean) => void;
  /** Scope key for per-hunk selection state. Empty disables persistence. */
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
  const { selectedHunkKeys, toggle: toggleHunk } = useSelectedHunks(
    hunkScopeKey ?? '',
  );
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
        (file.isBinary ? (
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
              {file.hunks.map((h) => {
                const hunkKey = `${file.path}@${h.oldStart}-${h.newStart}`;
                return (
                  <DiffHunk
                    hunk={h}
                    key={`${h.oldStart}-${h.newStart}`}
                    review={review}
                    repo={repo}
                    file={file.path}
                    highlight={highlight}
                    selected={selectedHunkKeys.has(hunkKey)}
                    onToggleSelected={
                      hunkScopeKey
                        ? (next: boolean) => toggleHunk(hunkKey, next)
                        : undefined
                    }
                  />
                );
              })}
            </tbody>
          </table>
        ))}
    </article>
  );
}
