import { peekPty } from './pty-pool.js';
import {
  readSessionActivity,
  type ActivityState,
} from './claude-activity.js';
import { getCommentFileStore } from './comment-file-store.js';
import { readPendingForSession } from './pending-delivery.js';
import type { WorktreeSession } from './history.js';

export type PtyStatus = 'running' | 'idle';

export interface SessionMeta {
  draftCount: number;
  commentCount: number;
  /** Comments authored by claude — used by the client to compute unread. */
  claudeCount: number;
  /** Set when *our* PTY pool has a live Claude for this session. Doesn't
   *  catch external terminals — `activityState` does. */
  ptyStatus: PtyStatus;
  /** ms since epoch of Claude's last write across this worktree, or null. */
  lastActivity: number | null;
  /** Derived from `lastActivity`: 'active' (≤30 s), 'open' (≤5 min), 'stale'. */
  activityState: ActivityState;
  /** Published user comments not yet surfaced to Claude via the
   *  UserPromptSubmit hook. Drops to zero after Claude takes its next turn. */
  pendingForClaudeCount: number;
}

/**
 * Cheap per-session metadata. Goes through the file-store cache so badge
 * counts reflect in-flight writes that haven't yet hit disk — reading the
 * raw JSON behind the cache's back produced stale counts under load.
 *
 * `session` is required because we need the worktree paths to look up
 * Claude's transcript directory (the sessionId hash alone isn't enough).
 */
export function readSessionMeta(
  sessionId: string,
  session: WorktreeSession,
): SessionMeta {
  const comments = getCommentFileStore(sessionId).snapshot();
  let drafts = 0;
  let claude = 0;
  for (const c of comments) {
    if (c.status === 'draft') drafts++;
    if (c.author === 'claude') claude++;
  }
  const activity = readSessionActivity(session);
  const pending = readPendingForSession(sessionId).length;
  return {
    draftCount: drafts,
    commentCount: comments.length,
    claudeCount: claude,
    ptyStatus: peekPty(sessionId) ? 'running' : 'idle',
    lastActivity: activity.lastActivity,
    activityState: activity.state,
    pendingForClaudeCount: pending,
  };
}
