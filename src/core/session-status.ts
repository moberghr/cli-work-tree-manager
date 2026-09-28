import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile, ensureFile, withFileLock } from './fs-safe.js';

/**
 * Per-session agent status, driven by Claude Code's own hooks (installed by
 * `work web`): UserPromptSubmit → working, Stop → idle (done, review me),
 * Notification with a permission/approval message → needs_input. Hooks are
 * the source of truth — no screen scraping — the approach Emdash uses.
 *
 * Stored one file per session under ~/.work/status/ so concurrent hooks for
 * different sessions never contend; same-session writes go through the file
 * lock (§5.2).
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
    case 'stop':
      return enter('idle', oneLine(event.lastMessage), false);
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

export function statusDir(): string {
  return path.join(getConfigDir(), 'status');
}

export function statusFileFor(sessionId: string): string {
  return path.join(statusDir(), `${sessionId}.json`);
}

export function readStatus(sessionId: string): SessionStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFileFor(sessionId), 'utf-8'));
    return raw && typeof raw.state === 'string' ? (raw as SessionStatus) : null;
  } catch {
    return null;
  }
}

async function updateStatus(
  sessionId: string,
  fn: (prev: SessionStatus | null) => SessionStatus | null,
): Promise<{ prev: SessionStatus | null; next: SessionStatus | null }> {
  const file = statusFileFor(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureFile(file, '{}');
  return withFileLock(file, () => {
    const prev = readStatus(sessionId);
    const next = fn(prev);
    if (next) atomicWriteFile(file, JSON.stringify(next, null, 2));
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
 * else, or idle straight out of working (a finished turn). Repeat events
 * (a second Stop, the 60 s idle nudge) stay silent.
 */
export function notifyKindForTransition(
  prev: Pick<SessionStatus, 'state'> | null,
  next: Pick<SessionStatus, 'state'> | null,
): 'idle' | 'needs_input' | null {
  if (!next) return null;
  if (next.state === 'needs_input' && prev?.state !== 'needs_input') return 'needs_input';
  if (next.state === 'idle' && prev?.state === 'working') return 'idle';
  return null;
}
