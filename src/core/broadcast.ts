/**
 * Core for `work broadcast`: queue a prompt to every (filtered) live session
 * via the existing pending-delivery mechanism. We do NOT touch PTYs — those
 * are per-process and unreachable from a separate CLI. Instead we post a
 * `published`, `author:'user'` comment to each session's comment file store;
 * `work hook prompt-submit` surfaces it on that session's next turn (see
 * pending-delivery.ts `readPendingForSession`, which selects exactly those).
 *
 * Because broadcast writes `~/.work` state from a SEPARATE process while
 * `work web` may be writing the same comment file, the write goes through
 * `withFileLock` + `atomicWriteFile` (§5.2): we lock, re-read the file from
 * disk, append, and atomically write back — so a concurrent server write
 * can't be lost or corrupted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  clearCommentStoreCache,
  commentsDir,
  commentsFileFor,
} from './comment-file-store.js';
import { ensureFile, withFileLock, atomicWriteFile } from './fs-safe.js';
import { sessionIdFor } from './web-state.js';
import { selectSessions, type FleetFilter } from './fleet.js';
import type { WorktreeSession } from './history.js';
import type { Comment } from './comment-types.js';

export interface BroadcastTarget {
  session: WorktreeSession;
  sessionId: string;
  commentId: string;
}

function readComments(file: string): Comment[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as Comment[]) : [];
  } catch {
    return [];
  }
}

/** Append one published user comment to a session's comment file under an
 *  advisory lock, so concurrent `work web` writes to the same file can't
 *  clobber each other. Returns the new comment's id. */
async function appendLocked(sessionId: string, body: string): Promise<string> {
  const file = commentsFileFor(sessionId);
  fs.mkdirSync(commentsDir(), { recursive: true });
  ensureFile(file, '[]');
  const comment: Comment = {
    id: crypto.randomBytes(8).toString('hex'),
    repo: '',
    file: '',
    line: 0,
    side: 'general',
    body,
    createdAt: new Date().toISOString(),
    author: 'user',
    status: 'published',
  };
  await withFileLock(file, () => {
    const existing = readComments(file);
    existing.push(comment);
    atomicWriteFile(file, JSON.stringify(existing, null, 2));
  });
  return comment.id;
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
    const commentId = await appendLocked(sessionId, body);
    out.push({ session, sessionId, commentId });
  }
  // Any in-process cache for these files is now stale (we wrote underneath it
  // via the lock path) — drop it so subsequent reads see the on-disk truth.
  if (out.length > 0) clearCommentStoreCache();
  return out;
}
