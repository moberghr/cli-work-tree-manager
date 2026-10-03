import type { AgentState } from '../status/attention.js';
import type { PermissionRequest, SendHow } from '../api-types.js';

/**
 * Driving a session from outside its terminal — another Claude, a script,
 * you in a shell: send it a message, wait for its turn to end, answer its
 * permission prompt. The policy is here; I/O is passed in (the routes in
 * session-control-routes.ts give the real one, tests a fake).
 *
 * A message goes the way every note to a session goes (§ saved prompts): a
 * published comment, which the dashboard types into a terminal it owns when
 * that Claude is idle, or which the prompt hook hands over on its next turn.
 * Never typed into a terminal directly.
 */

export const MAX_SEND_CHARS = 20_000;

export type { SendHow } from '../api-types.js';

export interface SendDeps {
  /** Queue it as a published comment (the comment route), resolving to what that route did with it: typed into an idle host Claude, left for the end of its turn, or null (no host terminal). */
  post: (id: string, body: string) => Promise<'typed' | 'next-turn' | null>;
  /** Its Claude runs in the PTY host. */
  hostRuns: (id: string) => boolean;
  /** Its Claude runs in a terminal outside work (seen in Claude Code's process files). */
  runningOutside: (id: string) => boolean;
  /** Start its Claude in the host, resuming its conversation, its first message saying a note is attached (NOTE_NUDGE). */
  start: (id: string) => Promise<boolean>;
  state: (id: string) => AgentState | null;
  /** It runs with permission checks off. */
  unsafe: (id: string) => boolean;
  archived: (id: string) => boolean;
}

export type SendResult = { ok: true; how: SendHow; sentAt: string } | { ok: false; status: 400 | 409 | 502; error: string };

export async function sendToSession(id: string, text: string, deps: SendDeps, opts: { force?: boolean; now?: () => Date } = {}): Promise<SendResult> {
  const body = text.trim();
  if (!body) return { ok: false, status: 400, error: 'the message is empty' };
  if (body.length > MAX_SEND_CHARS) return { ok: false, status: 400, error: `the message is over ${MAX_SEND_CHARS} characters` };
  if (deps.archived(id)) return { ok: false, status: 409, error: 'it is archived: restore it first' };
  // A message to a Claude with permission checks off runs whatever it says,
  // unreviewed — and it may have come from another agent. Your say-so first.
  if (deps.unsafe(id) && !opts.force) {
    return { ok: false, status: 409, error: 'its Claude runs with permission checks off (--unsafe), so it would act on this without asking you; send with --force if you mean it' };
  }
  const sentAt = (opts.now?.() ?? new Date()).toISOString();
  // What the comment route did, as it decided it — not a second look at the state.
  const delivered = await deps.post(id, body);
  if (delivered) return { ok: true, how: delivered, sentAt };
  if (deps.hostRuns(id)) return { ok: true, how: 'next-turn', sentAt };
  if (deps.runningOutside(id)) return { ok: true, how: 'outside', sentAt };
  if (!(await deps.start(id))) return { ok: false, status: 502, error: 'queued, but its Claude could not be started: it gets it when you open the session' };
  return { ok: true, how: 'started', sentAt };
}

/** What `how` means, in a line. */
export function sendHowText(how: SendHow): string {
  switch (how) {
    case 'typed':
      return 'sent: typed into its terminal';
    case 'next-turn':
      return 'queued: it is working, so it gets this when the turn ends';
    case 'outside':
      return 'queued: its Claude runs in a terminal outside work, and gets this on its next turn there';
    case 'started':
      return 'sent: its Claude was started (resuming its conversation) with this as the first message';
  }
}

export interface TurnStatus {
  state: AgentState;
  /** When it entered that state (ISO). */
  since: string;
  summary?: string;
}

export interface WaitDeps {
  status: (id: string) => TurnStatus | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type WaitResult = { ok: true; status: TurnStatus } | { ok: false; reason: 'timeout'; status: TurnStatus | null };

/**
 * Wait until the session isn't working: its turn ended (idle) or it asks
 * you something (needs input). With `after` (when a message was sent), only
 * a state entered after it counts — the turn that message started, not the
 * one before.
 */
export async function waitForTurn(id: string, deps: WaitDeps, opts: { after?: string; timeoutMs: number; pollMs?: number }): Promise<WaitResult> {
  const deadline = deps.now() + opts.timeoutMs;
  const after = opts.after ? Date.parse(opts.after) : null;
  for (;;) {
    const s = deps.status(id);
    const fresh = after === null || (!!s && Date.parse(s.since) > after);
    if (s && s.state !== 'working' && fresh) return { ok: true, status: s };
    if (deps.now() >= deadline) return { ok: false, reason: 'timeout', status: s };
    await deps.sleep(opts.pollMs ?? 1000);
  }
}

/** The permission prompt it is waiting on, if any (what `work answer` shows, and must send back). */
export function pendingRequest(status: { state: AgentState; request?: PermissionRequest } | null): PermissionRequest | null {
  return status?.state === 'needs_input' && status.request ? status.request : null;
}

/** Parse "15m", "90s", "2h", or a number of seconds. */
export function parseDuration(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return Math.round(n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000));
}
