import { useEffect, useMemo, useState } from 'react';
import { useExpandOptional } from '../../state/ExpandProvider.js';
import { useDiffMode } from '../../state/DiffModeProvider.js';
import {
  gapOffset,
  hiddenRemaining,
  nextBottomRange,
  nextTopRange,
  type DiffGap,
} from '../../utils/expand.js';
import { highlightBlock } from '../../utils/highlight.js';

interface RevealedLine {
  newNum: number;
  oldNum: number;
  content: string;
}

interface Props {
  repo: string;
  file: string;
  gap: DiffGap;
  /** Resolved hljs language for this file, or null to render plain text. */
  lang?: string | null;
  /** Notifies the parent when this gap becomes fully revealed (no hidden
   *  lines left between its anchors) so it can drop the now-redundant `@@`
   *  header on the hunk below. Only fires for gaps with a lower anchor —
   *  the tail gap has no hunk beneath it. */
  onClosedChange?: (closed: boolean) => void;
  /** The full `@@ … @@` heading of the hunk directly below this gap. Shown
   *  on the expander bar (GitHub-style) above the hidden-line count, so the
   *  arrows, heading, and count share one fatter row. */
  belowHeading?: string;
}

/**
 * Renders one expandable gap: the revealed context lines plus the
 * expander control that reveals more. Lines grow toward the middle —
 * the down arrow extends the block below the upper hunk, the up arrow
 * extends the block above the lower hunk. When no expand provider is
 * mounted (static `wd --static`, which has no server) this renders
 * nothing, so the diff degrades to plain hunks.
 */
export function GapRegion({
  repo,
  file,
  gap,
  lang,
  onClosedChange,
  belowHeading,
}: Props) {
  const exp = useExpandOptional();
  const mode = useDiffMode();
  const [topLines, setTopLines] = useState<RevealedLine[]>([]);
  const [bottomLines, setBottomLines] = useState<RevealedLine[]>([]);
  const [eof, setEof] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remainingForClose = hiddenRemaining(
    gap,
    topLines.length,
    bottomLines.length,
  );
  // A gap "closes" only against a hunk below it (head/mid gaps). Tail gaps
  // have a null `remaining` and no hunk beneath, so they never close.
  const closed = gap.bottom !== null && remainingForClose === 0;
  useEffect(() => {
    onClosedChange?.(closed);
  }, [closed, onClosedChange]);

  // Highlight each revealed run as a contiguous block (top and bottom are two
  // separate runs) so stateful grammars keep context, then key by line object
  // for per-cell lookup. Same rationale as DiffHunk's per-side highlighting.
  const lineHtml = useMemo(() => {
    if (!lang) return null;
    const m = new Map<RevealedLine, string>();
    const fill = (run: RevealedLine[]) => {
      const html = highlightBlock(run.map((l) => l.content), lang);
      run.forEach((l, i) => {
        const h = html[i];
        if (h) m.set(l, h);
      });
    };
    fill(topLines);
    fill(bottomLines);
    return m;
  }, [lang, topLines, bottomLines]);

  if (!exp) return null;

  const offset = gapOffset(gap);
  const toLines = (start: number, lines: string[]): RevealedLine[] =>
    lines.map((content, i) => {
      const newNum = start + i;
      return { newNum, oldNum: newNum + offset, content };
    });

  function expandDown() {
    const range = nextTopRange(gap, topLines.length, bottomLines.length);
    if (!range || busy) return;
    setBusy(true);
    setError(null);
    exp!
      .loadLines(repo, file, range.start, range.end)
      .then((res) => {
        setTopLines((prev) => [...prev, ...toLines(range.start, res.lines)]);
        // Tail gap (no lower anchor) relies on the server's eof flag to
        // know when to retire the control.
        if (gap.bottom === null && res.eof) setEof(true);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function expandUp() {
    const range = nextBottomRange(gap, topLines.length, bottomLines.length);
    if (!range || busy) return;
    setBusy(true);
    setError(null);
    exp!
      .loadLines(repo, file, range.start, range.end)
      .then((res) => {
        setBottomLines((prev) => [...toLines(range.start, res.lines), ...prev]);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }

  const canDown = nextTopRange(gap, topLines.length, bottomLines.length) !== null;
  const canUp = nextBottomRange(gap, topLines.length, bottomLines.length) !== null;
  // Tail gaps keep offering "down" until the server reports EOF; mid/head
  // gaps stop automatically once the ranges clamp to nothing.
  const tailExhausted = gap.bottom === null && (eof || !canDown);
  const showExpander = !tailExhausted && (canUp || canDown);
  const remaining = remainingForClose;

  return (
    <>
      {topLines.map((l) => (
        <ContextRow
          key={`t-${l.newNum}`}
          line={l}
          html={lineHtml?.get(l) ?? null}
          unified={mode === 'unified'}
        />
      ))}
      {showExpander && (
        <tr className="wd-row wd-expander-row">
          <td className="wd-expander-cell" colSpan={mode === 'unified' ? 3 : 4}>
            <div className="wd-expander">
              <div className="wd-expander-arrows">
                {/* Converging arrows, GitHub-style: the down-chevron (top)
                    reveals the lines just below the section above; the
                    up-chevron (bottom) reveals the lines just above the
                    section below. Each sits at, and points toward, the
                    lines it reveals. */}
                {canDown && (
                  <button
                    type="button"
                    className="wd-expander-btn"
                    title="Expand down"
                    aria-label="Expand lines below the section above"
                    disabled={busy}
                    onClick={expandDown}
                  >
                    ↓
                  </button>
                )}
                {canUp && (
                  <button
                    type="button"
                    className="wd-expander-btn"
                    title="Expand up"
                    aria-label="Expand lines above the section below"
                    disabled={busy}
                    onClick={expandUp}
                  >
                    ↑
                  </button>
                )}
              </div>
              <div className="wd-expander-text">
                <span className="wd-expander-label">
                  {error
                    ? `Couldn't expand: ${error}`
                    : remaining !== null
                      ? `${remaining} hidden line${remaining === 1 ? '' : 's'}`
                      : 'Expand'}
                </span>
                {belowHeading && (
                  <span className="wd-hunk-fn wd-expander-heading">
                    {belowHeading}
                  </span>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
      {bottomLines.map((l) => (
        <ContextRow
          key={`b-${l.newNum}`}
          line={l}
          html={lineHtml?.get(l) ?? null}
          unified={mode === 'unified'}
        />
      ))}
    </>
  );
}

function ContextRow({
  line,
  html,
  unified,
}: {
  line: RevealedLine;
  html: string | null;
  unified: boolean;
}) {
  // Unified: both gutters then a single content cell. Split: old gutter +
  // content, new gutter + content (content duplicated, since context is
  // identical on both sides).
  if (unified) {
    return (
      <tr className="wd-row wd-row-context">
        <td className="wd-ln wd-ln-old wd-context">{line.oldNum}</td>
        <td className="wd-ln wd-ln-new wd-context">{line.newNum}</td>
        <ContextCell content={line.content} html={html} />
      </tr>
    );
  }
  return (
    <tr className="wd-row wd-row-context">
      <td className="wd-ln wd-ln-old wd-context">{line.oldNum}</td>
      <ContextCell content={line.content} html={html} />
      <td className="wd-ln wd-ln-new wd-context">{line.newNum}</td>
      <ContextCell content={line.content} html={html} />
    </tr>
  );
}

function ContextCell({
  content,
  html,
}: {
  content: string;
  html: string | null;
}) {
  if (html !== null) {
    return (
      <td
        className="wd-content wd-context"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <td className="wd-content wd-context">{content || ' '}</td>;
}
