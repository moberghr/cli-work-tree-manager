import { compareAttention } from '../../../core/attention.js';
import { isArchived } from './session-display.js';
import type { SessionSummary } from '../api/client.js';

/**
 * The review queue: "Review all" on the inbox's Done section walks the
 * finished sessions one by one, each opened on its last turn. The order is
 * fixed when the queue starts (inbox order: longest-waiting first), so
 * opening one — which marks it seen and drops it from the inbox — doesn't
 * reshuffle the rest under you.
 */
export interface ReviewQueue {
  ids: string[];
}

/** Finished, not yet looked at — the inbox's Done section. */
export function isDoneUnseen(s: SessionSummary): boolean {
  return !isArchived(s) && s.attention?.state === 'idle' && !s.attention.seen;
}

export function startQueue(sessions: SessionSummary[]): ReviewQueue | null {
  const ids = sessions
    .filter(isDoneUnseen)
    .sort((a, b) => compareAttention(a.attention, b.attention))
    .map((s) => s.id);
  return ids.length ? { ids } : null;
}

/** 1-based position of `id`, or null when it isn't in the queue. */
export function queuePosition(q: ReviewQueue, id: string | null): number | null {
  const i = id ? q.ids.indexOf(id) : -1;
  return i < 0 ? null : i + 1;
}

/**
 * The next one to review after `currentId`: skips sessions that were
 * deleted or archived meanwhile. Null at the end of the queue.
 */
export function nextInQueue(q: ReviewQueue, currentId: string | null, sessions: SessionSummary[]): string | null {
  const live = new Set(sessions.filter((s) => !isArchived(s)).map((s) => s.id));
  const from = currentId ? q.ids.indexOf(currentId) : -1;
  for (let i = from + 1; i < q.ids.length; i++) {
    if (live.has(q.ids[i])) return q.ids[i];
  }
  return null;
}
