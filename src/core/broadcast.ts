/**
 * Core for `work broadcast`: queue a prompt to every (filtered) live session
 * via the existing pending-delivery mechanism. We do NOT touch PTYs — those
 * are per-process and unreachable from a separate CLI. Instead we post a
 * `published`, `author:'user'` comment to each session's comment file store;
 * `work hook prompt-submit` surfaces it on that session's next turn (see
 * pending-delivery.ts `readPendingForSession`, which selects exactly those).
 *
 * Public API only: `getCommentFileStore(sessionId).post(...)` and
 * `sessionIdFor(session)`. No internals are modified.
 */

import { getCommentFileStore } from './comment-file-store.js';
import { sessionIdFor } from './web-state.js';
import { selectSessions, type FleetFilter } from './fleet.js';
import type { WorktreeSession } from './history.js';

export interface BroadcastTarget {
  session: WorktreeSession;
  sessionId: string;
  commentId: string;
}

/**
 * Post `prompt` as a published user comment (side 'general') to every session
 * matching `filter`. Returns one entry per session queued.
 */
export function broadcastPrompt(
  sessions: WorktreeSession[],
  filter: FleetFilter,
  prompt: string,
): BroadcastTarget[] {
  const body = prompt.trim();
  if (!body) throw new Error('broadcast prompt is empty');

  const selected = selectSessions(sessions, filter);
  const out: BroadcastTarget[] = [];
  for (const session of selected) {
    const sessionId = sessionIdFor(session);
    const comment = getCommentFileStore(sessionId).post({
      body,
      side: 'general',
      author: 'user',
      status: 'published',
    });
    out.push({ session, sessionId, commentId: comment.id });
  }
  return out;
}
