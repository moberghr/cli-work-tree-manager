import fs from 'node:fs';
import path from 'node:path';
import { json, tx, withDb, type Db } from './db.js';

/**
 * Per-session agent status, driven by Claude Code's own hooks (installed by
 * `work web`): UserPromptSubmit → working, Stop → idle (done, review me),
 * Notification with a permission/approval message → needs_input. Hooks are
 * the source of truth — no screen scraping — the approach Emdash uses.
 *
 * Stored one row per session in state.db (see persistence below).
 */

import type { AgentState } from './attention.js';

export type { AgentState } from './attention.js';
export { attentionRank, compareAttention, needsAttention } from './attention.js';

export interface SessionStatus {
  state: AgentState;
  /** When the session entered `state` (ISO). */
  since: string;
  /** One line: the prompt while working, Claude's last message when idle,
   *  the permission request when it needs input. */
  summary?: string;
  /** False from the moment the session wants attention until the user looks
   *  at it (opens it in the dashboard, or answers it). */
  seen: boolean;
  updatedAt: string;
  /** State before the latest hook event (null for the first). Lets the
   *  server, which is only told "status changed", decide whether the
   *  transition deserves a notification. */
  prevState?: AgentState | null;
}

export type StatusEvent =
  | { kind: 'prompt'; prompt?: string }
  | { kind: 'stop'; lastMessage?: string }
  | { kind: 'notification'; message?: string };

/** Claude's Notification hook fires both for permission prompts and for the
 *  "waiting for your input" nudge after ~60 s idle; only the former means
 *  it's blocked on you. (Same regex Emdash settled on.) */
const NEEDS_INPUT_RE = /permission|approval|approve/i;

/** A finished turn whose message has a DECISION_MARKER line (attention.ts). */
const DECISION_RE = /^[\W_]*DECISION NEEDED\b[:\s-]*(.*)$/im;

/** Squash a prompt / message to one readable line. */
export function oneLine(text: string | undefined, max = 140): string | undefined {
  if (!text) return undefined;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '').trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/** Pure transition. `prev` is null for a session never seen before. */
export function applyStatusEvent(
  prev: SessionStatus | null,
  event: StatusEvent,
  now: Date = new Date(),
): SessionStatus {
  const ts = now.toISOString();
  const enter = (state: AgentState, summary: string | undefined, seen: boolean): SessionStatus => ({
    state,
    since: prev?.state === state ? prev.since : ts,
    summary: summary ?? prev?.summary,
    seen,
    updatedAt: ts,
  });
  switch (event.kind) {
    case 'prompt':
      // The user just typed into it — by definition they've seen it.
      return enter('working', oneLine(event.prompt), true);
    case 'stop': {
      const ask = event.lastMessage?.match(DECISION_RE);
      if (ask) return enter('needs_input', oneLine(ask[1]) ?? 'Claude needs a decision', false);
      return enter('idle', oneLine(event.lastMessage), false);
    }
    case 'notification': {
      if (event.message && NEEDS_INPUT_RE.test(event.message)) {
        return enter('needs_input', oneLine(event.message), false);
      }
      // The idle nudge: nothing new happened, don't re-flag it as unseen.
      if (prev) return { ...prev, updatedAt: ts };
      return enter('idle', undefined, false);
    }
  }
}

/** A "working" status with no Claude activity for this long is treated as
 *  idle: the Claude died, was killed, or the Stop hook never fired. */
export const STALE_WORKING_MS = 15 * 60_000;

export interface EffectiveStatus extends SessionStatus {
  /** True when `state` was downgraded from a stale "working". */
  stale: boolean;
}

/** Transcript activity this long after a needs-input notification means
 *  the question was answered. */
export const ANSWERED_AFTER_MS = 3_000;

export function effectiveStatus(
  status: SessionStatus,
  lastActivityMs: number,
  now: number = Date.now(),
): EffectiveStatus {
  const last = Math.max(lastActivityMs, Date.parse(status.updatedAt) || 0);
  if (status.state === 'working' && now - last > STALE_WORKING_MS) {
    return { ...status, state: 'idle', seen: true, stale: true };
  }
  // Approving a permission prompt fires no hook until the turn ends, so a
  // blocked session would look blocked while it's working again. Claude
  // writing its transcript after the question is the tell.
  const since = Date.parse(status.since) || 0;
  if (status.state === 'needs_input' && lastActivityMs > since + ANSWERED_AFTER_MS) {
    return { ...status, state: 'working', seen: true, stale: false };
  }
  return { ...status, stale: false };
}

// ---- persistence ----------------------------------------------------------

// One row per session in state.db's `session_status` (db.ts). Hooks for
// different sessions touch different rows; same-session updates are
// transactions, so two hooks racing can't lose an event.

function isStatus(x: unknown): x is SessionStatus {
  const s = x as SessionStatus | null;
  return !!s && typeof s === 'object' && typeof s.state === 'string' && typeof s.updatedAt === 'string';
}

function readRow(d: Db, sessionId: string): SessionStatus | null {
  const r = d.prepare('SELECT data FROM session_status WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
  const s = r ? json.parse(r.data) : null;
  return isStatus(s) ? s : null;
}

export function readStatus(sessionId: string): SessionStatus | null {
  return withDb((d) => readRow(d, sessionId));
}

async function updateStatus(
  sessionId: string,
  fn: (prev: SessionStatus | null) => SessionStatus | null,
): Promise<{ prev: SessionStatus | null; next: SessionStatus | null }> {
  return tx((d) => {
    const prev = readRow(d, sessionId);
    const next = fn(prev);
    if (next) {
      d.prepare('INSERT OR REPLACE INTO session_status (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(next));
    }
    return { prev, next };
  });
}

/**
 * Apply a hook event and persist it, keeping the pre-event state in
 * `prevState` for the server's notification decision.
 */
export function recordStatusEvent(
  sessionId: string,
  event: StatusEvent,
  now: Date = new Date(),
): Promise<{ prev: SessionStatus | null; next: SessionStatus | null }> {
  return updateStatus(sessionId, (prev) => ({
    ...applyStatusEvent(prev, event, now),
    prevState: prev?.state ?? null,
  }));
}

/** The user looked at it (opened it in the dashboard). */
export async function markSeen(sessionId: string): Promise<SessionStatus | null> {
  const { next } = await updateStatus(sessionId, (prev) =>
    prev && !prev.seen ? { ...prev, seen: true, updatedAt: new Date().toISOString() } : prev,
  );
  return next;
}

// ---- transcript summary ---------------------------------------------------

const TAIL_BYTES = 256 * 1024;

/**
 * Text of the last assistant message in a Claude Code transcript (JSONL),
 * for the "done" summary. Reads only the file's tail — transcripts get
 * large. Null when unreadable or there's no assistant text yet.
 */
export function lastAssistantText(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  let text: string;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue; // first line of a tail may be partial
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c): c is { type: string; text: string } => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
        .trim();
      if (parts) return parts;
    }
  }
  return null;
}

/**
 * Whether a status change deserves a desktop notification / status hook:
 * only on entering a state that wants the user — needs_input from anything
 * else, or idle out of a turn (a finished turn). Repeat events (a second
 * Stop, the 60 s idle nudge) stay silent.
 *
 * "Out of a turn" includes needs_input: approving a permission prompt fires
 * no hook, so a turn that paused for one is still stored as needs_input
 * when its Stop arrives — and that finish must notify like any other.
 */
export function notifyKindForTransition(
  prev: Pick<SessionStatus, 'state'> | null,
  next: Pick<SessionStatus, 'state'> | null,
): 'idle' | 'needs_input' | null {
  if (!next) return null;
  if (next.state === 'needs_input' && prev?.state !== 'needs_input') return 'needs_input';
  if (next.state === 'idle' && (prev?.state === 'working' || prev?.state === 'needs_input')) return 'idle';
  return null;
}
