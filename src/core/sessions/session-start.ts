import { getCommentFileStore } from '../comments/comment-file-store.js';
import { ensurePty, peekPty } from '../pty/pty-pool.js';

/** What happened to the first prompt of a created worktree. */
export type StartOutcome =
  | 'started' // Claude spawned in the PTY host with it
  | 'queued'; // the session was already running: delivered on its next turn

/**
 * Default `startSession`: spawn the session's Claude in the PTY host with
 * the prompt as its first message — or, when the worktree already existed
 * and its Claude is running, queue it like a review comment instead of
 * typing into a terminal that may be mid-turn or showing a prompt.
 */
export async function startSessionWithPrompt(sessionId: string, prompt: string): Promise<StartOutcome> {
  if (peekPty(sessionId)) {
    getCommentFileStore(sessionId).post({ side: 'general', status: 'published', author: 'user', body: prompt });
    return 'queued';
  }
  if (!(await ensurePty(sessionId, { initialPrompt: prompt }))) throw new Error('could not start the session');
  return 'started';
}
