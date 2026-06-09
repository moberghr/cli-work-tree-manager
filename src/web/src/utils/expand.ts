import type { Hunk } from '../api/client.js';

/** How many lines one expand click reveals. Matches GitHub's chunk size. */
export const EXPAND_CHUNK = 20;

/** A line bordering a gap: its number on each diff side. */
export interface GapAnchor {
  newNum: number;
  oldNum: number;
}

/**
 * An unchanged, collapsed region between (or around) hunks that the user
 * can expand. `top` is the line immediately above the gap, `bottom` the
 * line immediately below. A null anchor means the gap runs to the file's
 * edge — `top: null` is the head (lines before the first hunk), `bottom:
 * null` is the tail (lines after the last hunk, length unknown until EOF).
 */
export interface DiffGap {
  key: string;
  top: GapAnchor | null;
  bottom: GapAnchor | null;
}

/** Last line numbers a hunk occupies on each side. */
function hunkEnd(h: Hunk): GapAnchor {
  return {
    newNum: h.newStart + h.newLines - 1,
    oldNum: h.oldStart + h.oldLines - 1,
  };
}

/** First line numbers a hunk occupies on each side. */
function hunkStart(h: Hunk): GapAnchor {
  return { newNum: h.newStart, oldNum: h.oldStart };
}

/**
 * Derive the expandable gaps for a file's hunks: the head (before the
 * first hunk), each between-hunk gap wider than one line, and the tail
 * (after the last hunk). Between-gaps shorter than 2 lines are omitted —
 * there is nothing hidden to reveal.
 */
export function computeGaps(hunks: Hunk[]): DiffGap[] {
  if (hunks.length === 0) return [];
  const gaps: DiffGap[] = [];

  // Head: only when the first hunk doesn't already start at line 1.
  const first = hunks[0];
  if (first.newStart > 1) {
    gaps.push({ key: 'head', top: null, bottom: hunkStart(first) });
  }

  // Between consecutive hunks.
  for (let i = 0; i < hunks.length - 1; i++) {
    const top = hunkEnd(hunks[i]);
    const bottom = hunkStart(hunks[i + 1]);
    if (bottom.newNum - top.newNum > 1) {
      gaps.push({ key: `mid-${i}`, top, bottom });
    }
  }

  // Tail: always offered (file length is unknown client-side); the first
  // expand that returns no lines + eof retires the control.
  const last = hunks[hunks.length - 1];
  gaps.push({ key: 'tail', top: hunkEnd(last), bottom: null });

  return gaps;
}

/** old-minus-new line-number offset, constant across an unchanged gap. */
export function gapOffset(gap: DiffGap): number {
  if (gap.top) return gap.top.oldNum - gap.top.newNum;
  if (gap.bottom) return gap.bottom.oldNum - gap.bottom.newNum;
  return 0;
}

/** Inclusive 1-based new-side line range, or null when nothing remains. */
export interface FetchRange {
  start: number;
  end: number;
}

/**
 * Next range to fetch when expanding downward from the top of a gap.
 * `topCount` / `botCount` are how many lines are already revealed from each
 * end. For the tail gap (`bottom: null`) the range is open-ended down to
 * EOF, capped at the chunk size.
 */
export function nextTopRange(
  gap: DiffGap,
  topCount: number,
  botCount: number,
): FetchRange | null {
  const start = (gap.top ? gap.top.newNum : 0) + topCount + 1;
  const ceiling = gap.bottom
    ? gap.bottom.newNum - 1 - botCount
    : Number.POSITIVE_INFINITY;
  const end = Math.min(start + EXPAND_CHUNK - 1, ceiling);
  if (end < start) return null;
  return { start, end };
}

/**
 * Next range to fetch when expanding upward from the bottom of a gap.
 * Only valid when the gap has a bottom anchor.
 */
export function nextBottomRange(
  gap: DiffGap,
  topCount: number,
  botCount: number,
): FetchRange | null {
  if (!gap.bottom) return null;
  const end = gap.bottom.newNum - 1 - botCount;
  const floor = (gap.top ? gap.top.newNum : 0) + topCount + 1;
  const start = Math.max(floor, end - EXPAND_CHUNK + 1);
  if (end < start) return null;
  return { start, end };
}

/**
 * Lines still hidden in a gap with both anchors known. Returns null for the
 * tail gap, whose remaining count is unknown until EOF.
 */
export function hiddenRemaining(
  gap: DiffGap,
  topCount: number,
  botCount: number,
): number | null {
  if (!gap.bottom) return null;
  const totalGap = gap.bottom.newNum - 1 - (gap.top ? gap.top.newNum : 0);
  return Math.max(0, totalGap - topCount - botCount);
}
