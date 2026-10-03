import { json, tx, withDb, type Db } from './db.js';
import { contentBlocks, readTranscriptTail } from './transcript.js';
import type { ConversationEntry } from './agents/types.js';

/**
 * Per-session agent status, driven by Claude Code's own hooks (installed by
 * `work web`): UserPromptSubmit → working, Stop → idle (done, review me),
 * Notification with a permission/approval message → needs_input. Hooks are
 * the source of truth — no screen scraping — the approach Emdash uses.
 *
 * Stored one row per session in state.db (see persistence below).
 */

import type { AgentState } from './attention.js';
import type { PermissionRequest } from './permission-request.js';

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
  /** While needs_input on a permission prompt: the tool call it is about
   *  (from the transcript), so the inbox can show it and answer it. */
  request?: PermissionRequest;
  /** When the last turn ended (the Stop hook). `since` doesn't move on an
   *  idle → idle stop, and `updatedAt` moves on seen and on the idle nudge;
   *  this is what transcript activity is compared with (effectiveStatus). */
  turnEndedAt?: string;
}

export type { StatusEvent } from './status-event.js';
import type { StatusEvent } from './status-event.js';

/** Claude's Notification hook fires both for permission prompts and for the
 *  "waiting for your input" nudge after ~60 s idle; only the former means
 *  it's blocked on you. (Same regex Emdash settled on.) */
const NEEDS_INPUT_RE = /permission|approval|approve|needs your input|needs network access/i;

/** `notification_type`s that mean Claude waits on you (vs idle_prompt, auth_success). */
const WAITS_ON_YOU = new Set(['permission_prompt', 'elicitation_dialog']);

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
      // A turn ended now: `since` is now even when no prompt hook marked it
      // working (a `!` command, a background task's result) — "finished 2m ago".
      const ask = event.lastMessage?.match(DECISION_RE);
      if (ask) return { ...enter('needs_input', oneLine(ask[1]) ?? 'Claude needs a decision', false), since: ts, turnEndedAt: ts };
      return { ...enter('idle', oneLine(event.lastMessage), false), since: ts, turnEndedAt: ts };
    }
    case 'notification': {
      // Claude Code says what kind (`notification_type`): a permission prompt
      // or a question / dialog for you, or "idle at its prompt" (a minute
      // after it stopped). The message text is the fallback for older
      // versions: it missed "Claude needs your input" and the like.
      const blocks = event.type ? WAITS_ON_YOU.has(event.type) : !!event.message && NEEDS_INPUT_RE.test(event.message);
      if (event.type === 'idle_prompt' && prev && (prev.state === 'working' || prev.state === 'needs_input')) {
        // Waiting at its prompt with no Stop: the turn was interrupted (Esc,
        // a denied permission) — by you, so nothing to flag.
        return { ...enter('idle', prev.summary, true), turnEndedAt: ts };
      }
      if (blocks) {
        const next = enter('needs_input', oneLine(event.message), false);
        return event.request ? { ...next, request: event.request } : next;
      }
      // The idle nudge: nothing new happened, don't re-flag it as unseen.
      if (prev) return { ...prev, updatedAt: ts };
      return enter('idle', undefined, false);
    }
    case 'continue':
      return enter('working', oneLine(event.what) ?? prev?.summary, prev?.seen ?? true);
    case 'answered': {
      // Allowed: the tool runs, the turn goes on. Denied: Claude stops and
      // waits for you to say what to do instead.
      const what = prev?.request ? `${prev.request.tool}: ${prev.request.detail}` : 'the request';
      return event.answer === 'allow'
        ? enter('working', oneLine(`Allowed ${what}`), true)
        : enter('idle', oneLine(`Denied ${what} — tell Claude what to do instead`), true);
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
  /** The newest transcript entry that is a turn's work (yours or Claude's:
   *  `lastTurnEntryMs`), when the caller read it; 0 = unknown. */
  lastTurnEntryMs = 0,
): EffectiveStatus {
  const last = Math.max(lastActivityMs, Date.parse(status.updatedAt) || 0);
  if (status.state === 'working' && now - last > STALE_WORKING_MS) {
    return { ...status, state: 'idle', seen: true, stale: true };
  }
  // Approving a permission prompt fires no hook until the turn ends, so a
  // blocked session would look blocked while it's working again. Claude
  // writing its transcript after the question is the tell.
  // Answered in its terminal: Claude wrote a turn's message (a tool result,
  // its reply) after the question. Its own lines — the away summary a few
  // minutes after every turn, the last-prompt / cost lines on exit — are no
  // answer, so only turn entries count (`lastTurnEntryMs`, when the caller
  // read them; the bare transcript time otherwise). Quiet 15 min: idle.
  const since = Date.parse(status.since) || 0;
  const answeredAt = lastTurnEntryMs || lastActivityMs;
  if (status.state === 'needs_input' && answeredAt > since + ANSWERED_AFTER_MS) {
    if (now - answeredAt > STALE_WORKING_MS) return { ...status, state: 'idle', seen: true, stale: true };
    return { ...status, state: 'working', seen: true, stale: false };
  }
  // Some turns fire no prompt hook: a `!` shell command and Claude's turn on
  // its output, or any turn while work's hooks were being reinstalled (a work
  // web restart). The session read "idle" while it worked. A message in its
  // transcript after the last turn ended is the tell; quiet for 15 min, it
  // decays like a working status.
  if (
    status.state === 'idle' &&
    lastTurnEntryMs > idleFrom(status) + ANSWERED_AFTER_MS &&
    now - lastTurnEntryMs <= STALE_WORKING_MS
  ) {
    return { ...status, state: 'working', seen: true, stale: false };
  }
  return { ...status, stale: false };
}

/**
 * Claude Code's own word on a running Claude (~/.claude/sessions/<pid>.json,
 * via SessionClaudes) over what the hooks recorded, when it is newer: the
 * hooks miss turns (a work web restart, an interrupt, a Stop that handed
 * Claude more work), Claude Code's file doesn't. Busy → working, waiting →
 * needs input, idle → a working / needs-input record is over.
 *
 * And with nothing running for the session anywhere (`known`: the process
 * list was read; `hosted`: no PTY or chat of ours either), it can't be working
 * or waiting: idle at once, not after 15 quiet minutes.
 */
export function withLiveClaude(
  status: EffectiveStatus,
  live: { state?: 'busy' | 'idle' | 'waiting'; stateAt?: number; waitingFor?: string } | null,
  opts: { known: boolean; hosted: boolean },
): EffectiveStatus {
  const recorded = Date.parse(status.updatedAt) || 0;
  if (live?.state && (live.stateAt ?? 0) > recorded) {
    if (live.state === 'busy' && status.state !== 'working') return { ...status, state: 'working', seen: true, stale: false };
    if (live.state === 'waiting' && status.state !== 'needs_input') {
      return { ...status, state: 'needs_input', seen: false, stale: false, summary: live.waitingFor ? `Waiting for you: ${live.waitingFor}` : 'Waiting for you' };
    }
    if (live.state === 'idle' && (status.state === 'working' || status.state === 'needs_input')) return { ...status, state: 'idle', seen: true, stale: true };
  }
  if (!live && opts.known && !opts.hosted && (status.state === 'working' || status.state === 'needs_input')) {
    return { ...status, state: 'idle', seen: true, stale: true };
  }
  return status;
}

/** When an idle session's last turn ended: the Stop hook's time, else (a row from before it was kept) `since`. */
export function idleFrom(status: SessionStatus): number {
  return Date.parse(status.turnEndedAt ?? '') || Date.parse(status.since) || 0;
}

/**
 * The newest entry that is a turn's work: your prompt or `!` command and its
 * output, the agent's message or tool call, a tool's result, a background
 * task's result. Not what the agent writes around a turn (durations, hook
 * summaries, away summaries, PR links, titles), slash commands, compaction
 * or meta lines (the agent's mapping marks those: `meta`, no `turn`). Pure;
 * 0 when there is none.
 */
export function lastTurnEntryMs(entries: readonly ConversationEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.meta) continue;
    if (e.role === 'other' && !e.turn) continue;
    const ms = Date.parse(e.at);
    if (ms) return ms;
  }
  return 0;
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
    // A Stop ends a turn even when no prompt hook said one began (a `!`
    // command, a background task's result): as far as notifying goes, it
    // was working — so you hear that it finished.
    prevState: event.kind === 'stop' && prev?.state === 'idle' ? 'working' : (prev?.state ?? null),
  }));
}

/**
 * Its Claude is in the middle of a turn: working, or stopped mid-turn at a
 * dialog for you (a permission prompt, a question) — a needs-input state
 * entered after the last turn ended. A finished turn that asks you something
 * (DECISION NEEDED, recorded by the Stop) is not: its turn is over. Stopping
 * a Claude mid-turn cuts the turn off (a pending tool call is lost), so the
 * merged-work archive waits for this, and only this.
 */
export function turnInProgress(s: Pick<SessionStatus, 'state' | 'since' | 'turnEndedAt'> | null): boolean {
  if (!s) return false;
  if (s.state === 'working') return true;
  if (s.state !== 'needs_input') return false;
  const ended = s.turnEndedAt ? Date.parse(s.turnEndedAt) : NaN;
  return !(ended >= Date.parse(s.since));
}

/** The user looked at it (opened it in the dashboard). */
export async function markSeen(sessionId: string): Promise<SessionStatus | null> {
  const { next } = await updateStatus(sessionId, (prev) =>
    prev && !prev.seen ? { ...prev, seen: true, updatedAt: new Date().toISOString() } : prev,
  );
  return next;
}

// ---- transcript summary ---------------------------------------------------

/**
 * Text of the last assistant message in a Claude Code transcript (JSONL),
 * for the "done" summary. Null when unreadable or there's no assistant text yet.
 */
export function lastAssistantText(transcriptPath: string | undefined): string | null {
  const entries = readTranscriptTail(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const text = contentBlocks(entries[i])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
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
