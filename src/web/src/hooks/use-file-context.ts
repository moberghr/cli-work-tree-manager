import { useEffect, useState } from 'react';
import type { ParsedFile } from '../api/client.js';
import type { ExpandContextValue } from '../state/ExpandProvider.js';
import type { FileContext } from '../components/Diff/DiffHunk.js';
import { highlightBlock } from '../utils/highlight.js';

/** Read and highlighted at most this far: a file whose hunks reach past it keeps highlighting each hunk on its own (one big file mustn't stall the page). */
export const FILE_CONTEXT_MAX_LINES = 5000;

/** How far into the newer side a file's hunks reach: the lines to read for their context. 0: nothing to read. */
export function contextEnd(file: Pick<ParsedFile, 'hunks' | 'status' | 'isBinary'>): number {
  if (file.isBinary || file.status === 'deleted') return 0;
  return file.hunks.reduce((end, h) => Math.max(end, h.newStart + h.newLines - 1), 0);
}

/**
 * The file's newer side from its first line (to its end, at most
 * FILE_CONTEXT_MAX_LINES: the lines you expand below the last hunk too), highlighted as
 * one block (`FileContext`), so a hunk that starts inside a raw string or a
 * comment is coloured as the file is, not as if the closing quote opened
 * one. Read through the diff's expand provider (the version the diff shows);
 * null until it's read, and for good when there's nothing to read it with
 * (static mode), no language, or a file past FILE_CONTEXT_MAX_LINES —
 * DiffHunk then highlights each hunk alone, as before.
 */
export function useFileContext(
  file: ParsedFile,
  repo: string | undefined,
  lang: string | null,
  expand: ExpandContextValue | null,
): FileContext | null {
  const [ctx, setCtx] = useState<FileContext | null>(null);
  const end = contextEnd(file);
  useEffect(() => {
    setCtx(null);
    if (!expand || !repo || !lang || end <= 0 || end > FILE_CONTEXT_MAX_LINES) return;
    let live = true;
    expand.loadLines(repo, file.path, 1, FILE_CONTEXT_MAX_LINES).then(
      (r) => {
        if (!live || r.start !== 1) return;
        setCtx({ lang, lines: r.lines, html: highlightBlock(r.lines, lang) });
      },
      () => {}, // can't read it: each hunk alone, as before
    );
    return () => {
      live = false;
    };
  }, [expand, repo, lang, file.path, end, file.hunks]);
  return ctx;
}
