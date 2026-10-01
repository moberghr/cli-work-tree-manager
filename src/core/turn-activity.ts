import { latestTranscript } from './context-usage.js';
import { readTranscriptTail } from './transcript.js';
import { ANSWERED_AFTER_MS, effectiveStatus, idleFrom, lastTurnEntryMs, type EffectiveStatus, type SessionStatus } from './session-status.js';
import type { WorktreeSession } from './session-types.js';

/**
 * A session's status as the dashboard shows it: the hooks' record
 * (effectiveStatus), plus what its transcript says when the hooks missed a
 * turn — an idle session whose transcript gained a message after its last
 * turn ended is working (a `!` command, or a turn while work web restarted).
 *
 * The transcript is read only then (written after the turn ended), and once
 * per change: cached by file, size and mtime.
 */

const cache = new Map<string, { key: string; ms: number }>();

export function sessionStatusView(
  status: SessionStatus,
  session: WorktreeSession,
  lastActivityMs: number,
  now = Date.now(),
): EffectiveStatus {
  let turnMs = 0;
  if (status.state === 'idle' && lastActivityMs > idleFrom(status) + ANSWERED_AFTER_MS) {
    const t = latestTranscript(session);
    if (t) {
      const key = `${t.size}:${t.mtimeMs}`;
      const hit = cache.get(t.file);
      if (hit?.key === key) turnMs = hit.ms;
      else {
        turnMs = lastTurnEntryMs(readTranscriptTail(t.file));
        cache.set(t.file, { key, ms: turnMs });
      }
    }
  }
  return effectiveStatus(status, lastActivityMs, now, turnMs);
}
