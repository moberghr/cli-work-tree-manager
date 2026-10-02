import type { ConversationEntry } from './agents/types.js';
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

/** The agent's own line: its message or tool call, or a tool's result coming back to it.
 *  A subagent's lines count too (unlike the digest's prompts): its work is
 *  the agent's work, and the steps of one file never overlap, so nothing is
 *  counted twice. */
function isAgents(e: ConversationEntry): boolean {
  return e.role === 'agent' || e.role === 'tool' || e.role === 'tool-result';
}

/**
 * The steps in `entries` (in file order), continuing from `prevMs` — the
 * time of the line before them, when they continue a file already read.
 * Returns the steps and the time of the last line, to continue from.
 */
export function workSteps(entries: readonly ConversationEntry[], prevMs: number | null = null): { steps: WorkStep[]; lastMs: number | null } {
  const steps: WorkStep[] = [];
  let prev = prevMs;
  for (const e of entries) {
    const ts = Date.parse(e.at);
    if (!Number.isFinite(ts)) continue;
    if (prev !== null && isAgents(e)) {
      const gap = ts - prev;
      if (gap > 0) steps.push([ts, Math.min(gap, STEP_CAP_MS)]);
    }
    // Lines can arrive a little out of order (a subagent's): never step back.
    prev = prev === null ? ts : Math.max(prev, ts);
  }
  return { steps, lastMs: prev };
}

/**
 * Steps from several transcripts of one session (two Claudes on one folder
 * at once, a conversation resumed beside another) as one timeline: time
 * covered by both counts once. Pure.
 */
export function mergeSteps(steps: readonly WorkStep[]): WorkStep[] {
  const spans = steps.map(([end, ms]) => [end - ms, end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: WorkStep[] = [];
  let cur: [number, number] | null = null;
  for (const [start, end] of spans) {
    if (cur && start <= cur[1]) cur[1] = Math.max(cur[1], end);
    else {
      if (cur) out.push([cur[1], cur[1] - cur[0]]);
      cur = [start, end];
    }
  }
  if (cur) out.push([cur[1], cur[1] - cur[0]]);
  return out;
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
