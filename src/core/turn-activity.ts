import { readTranscriptTail } from './transcript.js';
import { agentFor } from './agents/index.js';
import { loadConfig } from './config.js';
import { ANSWERED_AFTER_MS, effectiveStatus, idleFrom, lastTurnEntryMs, readStatus, type EffectiveStatus, type SessionStatus } from './session-status.js';
import type { WorktreeSession } from './session-types.js';
import { readSessionActivity } from './session-activity.js';
import { sessionIdFor } from './session-id.js';

/**
 * A session's status as the dashboard shows it: the hooks' record
 * (effectiveStatus), plus what its transcript says when the hooks missed a
 * turn — an idle session whose transcript gained a message after its last
 * turn ended is working (a `!` command, or a turn while work web restarted),
 * and one waiting on you is answered only by a turn's message, not by the
 * lines Claude Code writes on its own (away summaries, exit).
 *
 * The transcript is read only then (written after the turn ended / the
 * question), and once per change: cached by file, size and mtime.
 */

const cache = new Map<string, { key: string; ms: number }>();

export function sessionStatusView(
  status: SessionStatus,
  session: WorktreeSession,
  lastActivityMs: number,
  now = Date.now(),
): EffectiveStatus {
  let turnMs = 0;
  const after = status.state === 'idle' ? idleFrom(status) : status.state === 'needs_input' ? Date.parse(status.since) || 0 : null;
  if (after !== null && lastActivityMs > after + ANSWERED_AFTER_MS) {
    // Its newest conversation, read through its agent (none: nothing to go on but the hooks).
    const conv = agentFor(loadConfig(), session).conversation;
    let t: { file: string; size: number; mtimeMs: number } | null = null;
    for (const f of conv?.files(session) ?? []) if (!t || f.mtimeMs > t.mtimeMs) t = f;
    if (conv && t) {
      const key = `${t.size}:${t.mtimeMs}`;
      const hit = cache.get(t.file);
      if (hit?.key === key) turnMs = hit.ms;
      else {
        turnMs = lastTurnEntryMs(conv.entries(readTranscriptTail(t.file)));
        cache.set(t.file, { key, ms: turnMs });
      }
    }
  }
  return effectiveStatus(status, lastActivityMs, now, turnMs);
}

/**
 * Its state as the dashboard shows it, for an action that refuses a Claude
 * mid-turn or waiting on you. Not the stored row alone: a Claude that died
 * mid-turn (no Stop hook) leaves "working" there for good, and the action
 * would be refused long after the dashboard shows it idle.
 */
export function shownState(session: WorktreeSession): SessionStatus['state'] | null {
  const raw = readStatus(sessionIdFor(session));
  return raw ? sessionStatusView(raw, session, readSessionActivity(session).lastActivity ?? 0).state : null;
}
