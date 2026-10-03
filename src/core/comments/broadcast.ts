/**
 * Core for `work broadcast`: queue a prompt to every (filtered) live session
 * via the existing pending-delivery mechanism. We do NOT touch PTYs — those
 * are per-process and unreachable from a separate CLI. Instead we post a
 * `published`, `author:'user'` comment to each session's comment file store;
 * `work hook prompt-submit` surfaces it on that session's next turn (see
 * pending-delivery.ts `readPendingForSession`, which selects exactly those).
 *
 * Broadcast writes from a SEPARATE process while `work web` may be writing
 * the same session's comments; the comment store's writes are database
 * transactions that reload first, so neither side's write is lost.
 */

import { getCommentFileStore } from './comment-file-store.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { selectSessions, type FleetFilter } from '../sessions/fleet.js';
import type { WorktreeSession } from '../sessions/history.js';

export interface BroadcastTarget {
  session: WorktreeSession;
  sessionId: string;
  commentId: string;
}

/**
 * Post `prompt` as a published user comment (side 'general') to every session
 * matching `filter`. Returns one entry per session queued.
 */
export async function broadcastPrompt(
  sessions: WorktreeSession[],
  filter: FleetFilter,
  prompt: string,
): Promise<BroadcastTarget[]> {
  const body = prompt.trim();
  if (!body) throw new Error('broadcast prompt is empty');

  const selected = selectSessions(sessions, filter);
  const out: BroadcastTarget[] = [];
  for (const session of selected) {
    const sessionId = sessionIdFor(session);
    // The store's post is a transaction that reloads first, so a
    // concurrent work web write to the same session can't be lost.
    const c = getCommentFileStore(sessionId).post({ side: 'general', status: 'published', author: 'user', body });
    out.push({ session, sessionId, commentId: c.id });
  }
  return out;
}
