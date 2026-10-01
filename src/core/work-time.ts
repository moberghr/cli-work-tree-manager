import { contentBlocks, type TranscriptEntry } from './transcript-entry.js';
import { dayKey } from './work-time-view.js';

/**
 * How long a session's Claude worked, from its transcripts — for a worklog,
 * or to see where the time went. Approximate by design: the time between
 * two transcript lines counts when the later one is Claude's own (its reply,
 * a tool's result), each gap at most STEP_CAP_MS — so your time reading and
 * typing isn't counted, and a permission prompt left an hour isn't an hour of
 * work. Pure: entries in, steps out.
 */

/** The most one step counts for (a long test run still counts; a prompt waiting all afternoon doesn't). */
export const STEP_CAP_MS = 15 * 60_000;

/** One step of Claude's: when it ended (ms) and how long it counted for. */
export type WorkStep = readonly [endMs: number, ms: number];

/** Claude's own line: its message, or a tool's result coming back to it. */
function isClaudes(e: TranscriptEntry): boolean {
  if (e.type === 'assistant') return true;
  return e.type === 'user' && contentBlocks(e).some((b) => b.type === 'tool_result');
}

/**
 * The steps in `entries` (in file order), continuing from `prevMs` — the
 * time of the line before them, when they continue a file already read.
 * Returns the steps and the time of the last line, to continue from.
 */
export function workSteps(entries: readonly TranscriptEntry[], prevMs: number | null = null): { steps: WorkStep[]; lastMs: number | null } {
  const steps: WorkStep[] = [];
  let prev = prevMs;
  for (const e of entries) {
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (prev !== null && isClaudes(e)) {
      const gap = ts - prev;
      if (gap > 0) steps.push([ts, Math.min(gap, STEP_CAP_MS)]);
    }
    // Lines can arrive a little out of order (a subagent's): never step back.
    prev = prev === null ? ts : Math.max(prev, ts);
  }
  return { steps, lastMs: prev };
}

/** Time worked in steps ending at or after `sinceMs` (and before `untilMs`). */
export function workedBetween(steps: readonly WorkStep[], sinceMs = 0, untilMs = Infinity): number {
  let ms = 0;
  for (const [end, d] of steps) if (end >= sinceMs && end < untilMs) ms += d;
  return ms;
}

/** Time worked per local day (`YYYY-MM-DD`), newest first, for the days after `sinceMs`. */
export function workedByDay(steps: readonly WorkStep[], sinceMs = 0): Array<{ day: string; ms: number }> {
  const by = new Map<string, number>();
  for (const [end, d] of steps) {
    if (end < sinceMs) continue;
    const k = dayKey(end);
    by.set(k, (by.get(k) ?? 0) + d);
  }
  return [...by].map(([day, ms]) => ({ day, ms })).sort((a, b) => b.day.localeCompare(a.day));
}
