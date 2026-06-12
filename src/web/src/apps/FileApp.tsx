import { useEffect, useMemo, useState } from 'react';
import { fetchFileLines } from '../api/client.js';
import { highlightBlock, resolveHighlightLang } from '../utils/highlight.js';

interface Props {
  /** Scope hash for the `work web` endpoint; undefined → standalone server. */
  hash?: string;
}

/**
 * Standalone "whole file" view, opened in a new tab from a diff file's
 * header. Renders the full working-tree file read-only with line numbers
 * and syntax highlighting — the surrounding-context counterpart to the
 * inline "expand lines" control, for when the user wants the entire file
 * rather than the next few lines.
 *
 * Reads `repo` / `path` (and optional `ref`) from the query string and
 * pulls the content via the same `/file-lines` endpoint expand uses,
 * requesting the whole range.
 */
export function FileApp({ hash }: Props) {
  const params = new URLSearchParams(window.location.search);
  const repo = params.get('repo') ?? '';
  const filePath = params.get('path') ?? '';
  const ref = params.get('ref') ?? undefined;

  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setError('No file path given.');
      return;
    }
    let cancelled = false;
    // MAX_SAFE_INTEGER as the end line: the server clamps to the real line
    // count, so this returns the whole file in one read.
    fetchFileLines(hash, repo, filePath, 1, Number.MAX_SAFE_INTEGER, ref).then(
      (r) => { if (!cancelled) setLines(r.lines); },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [hash, repo, filePath, ref]);

  useEffect(() => {
    document.title = filePath ? `${filePath} — file` : 'file';
  }, [filePath]);

  // Highlight the whole file as one block (not line by line) so stateful
  // grammars — Razor's `@code` C# sublanguage, multi-line comments/strings —
  // keep context across lines. Result is indexed by line.
  const htmlLines = useMemo(() => {
    const lang = resolveHighlightLang(filePath);
    if (!lang || !lines) return null;
    return highlightBlock(lines, lang);
  }, [filePath, lines]);

  if (error) {
    return <div className="wd-web-error">{error}</div>;
  }
  if (!lines) {
    return <div className="wd-web-empty">Loading {filePath}…</div>;
  }

  return (
    <div className="wd-fileview">
      <header className="wd-fileview-header">
        <span className="wd-fileview-path">{filePath}</span>
        <span className="wd-fileview-meta">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      </header>
      <table className="wd-fileview-table">
        <tbody>
          {lines.map((content, i) => {
            // null (blank line / no language) → plain branch, which renders a
            // space so the blank line keeps its row height.
            const html = htmlLines?.[i] ?? null;
            return (
              <tr key={i} className="wd-fileview-row">
                <td className="wd-fileview-ln">{i + 1}</td>
                {html !== null ? (
                  <td
                    className="wd-fileview-content"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ) : (
                  <td className="wd-fileview-content">{content || ' '}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
