import type { CommandModule } from 'yargs';
import { readSessionActivity } from '../core/claude-activity.js';
import {
  findSessionForCwd,
  formatPendingForPrompt,
  claimForDelivery,
  readPendingForWorktree,
  sessionIdFor,
} from '../core/pending-delivery.js';
import { isInternalClaude } from '../core/internal-claude.js';
import { readWebUrl } from '../core/web-discovery.js';
import {
  lastAssistantText,
  recordStatusEvent,
  type StatusEvent,
} from '../core/session-status.js';
import { bestEffortAsync } from '../core/best-effort.js';
import { pendingToolUse } from '../core/permission-request.js';
import { readTranscriptTail } from '../core/transcript.js';

/**
 * `work hook prompt-submit` / `work hook stop` — invoked by Claude Code's
 * UserPromptSubmit / Stop hooks (registered by `work web` on startup).
 * Reads pending review comments for the worktree the user is currently
 * in, prints them in the format Claude Code expects for that event, and
 * marks them delivered so they don't repeat.
 *
 * Exits silently when:
 *   - cwd isn't a `work`-managed worktree
 *   - there are no pending comments
 *   - Claude isn't actively running in this worktree (paranoia — the hook
 *     only fires from inside a running Claude, but we double-check)
 */
export type HookEvent =
  | 'prompt-submit'
  | 'stop'
  | 'checkpoint'
  | 'checkpoint-seal'
  | 'status-prompt'
  | 'status-stop'
  | 'status-notify';

const STATUS_EVENTS = new Set<HookEvent>(['status-prompt', 'status-stop', 'status-notify']);

/**
 * Fire-and-forget POST to the running `work web`. Shared by the two
 * checkpoint hooks: `checkpoint` (Stop) hits `api/checkpoint` to refresh the
 * instruction's live step; `checkpoint-seal` (UserPromptSubmit) hits
 * `api/checkpoint/seal` to close it so the next prompt opens a fresh step.
 * Silent + best-effort — no work web running, or cwd not a tracked scope, is
 * a no-op, and we never block Claude's turn on it.
 */
async function postToWeb(route: string, cwd: string): Promise<void> {
  const base = readWebUrl();
  if (!base) return; // no work web running
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort — never block Claude's turn on a checkpoint */
  } finally {
    clearTimeout(timer);
  }
}

export interface HookInput {
  event: HookEvent;
  cwd: string;
}

export interface HookOutput {
  /** Plain text appended to the user's prompt (prompt-submit) or
   *  raw JSON `{decision:'block', reason}` that prevents stop (stop). */
  stdout: string;
  /** The comment ids surfaced — caller marks them delivered. */
  deliveredIds: string[];
  /** The session id that produced the output, when there was something
   *  to deliver. Null otherwise (so the caller knows to skip markDelivered). */
  sessionId: string | null;
}

/**
 * Pure transformation: given an event and cwd, produce the stdout payload
 * Claude Code expects plus the ids to mark delivered. Returns null when
 * there's nothing to surface. No I/O on stdin/stdout — the caller wraps.
 */
export function computeHookOutput(
  input: HookInput,
  /** Which of these ids this caller may deliver. The real hook claims them
   *  atomically (claimForDelivery) so a racing PTY push can't send them too;
   *  the default keeps this function pure for tests. */
  claim: (sessionId: string, ids: string[]) => string[] = (_s, ids) => ids,
): HookOutput | null {
  const session = findSessionForCwd(input.cwd);
  if (!session) return null;

  const activity = readSessionActivity(session);
  if (activity.state === 'stale') return null;

  const sessionId = sessionIdFor(session);
  const unclaimed = readPendingForWorktree(session);
  if (unclaimed.length === 0) return null;
  const mine = new Set(claim(sessionId, unclaimed.map((c) => c.id)));
  const pending = unclaimed.filter((c) => mine.has(c.id));
  if (pending.length === 0) return null;

  const text = formatPendingForPrompt(pending);
  if (!text) return null;

  const ids = pending.map((c) => c.id);

  if (input.event === 'prompt-submit') {
    return { stdout: text + '\n', deliveredIds: ids, sessionId };
  }
  // Stop hook: `decision: 'block'` keeps Claude in the turn and feeds
  // `reason` back as additional context.
  return {
    stdout: JSON.stringify({ decision: 'block', reason: text }) + '\n',
    deliveredIds: ids,
    sessionId,
  };
}

interface HookPayload {
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** Notification */
  message?: string;
  /** Stop (and others): the conversation's JSONL transcript. */
  transcript_path?: string;
}

/** Map a status hook + its payload to a status event. Exported for tests. */
export function statusEventFor(event: HookEvent, payload: HookPayload): StatusEvent | null {
  switch (event) {
    case 'status-prompt':
      return { kind: 'prompt', prompt: payload.prompt };
    case 'status-stop':
      return { kind: 'stop', lastMessage: lastAssistantText(payload.transcript_path) ?? undefined };
    case 'status-notify': {
      // Which call the permission prompt is about: the transcript has it,
      // the hook message only names the tool.
      const request = pendingToolUse(readTranscriptTail(payload.transcript_path));
      return { kind: 'notification', message: payload.message, ...(request ? { request } : {}) };
    }
    default:
      return null;
  }
}

async function readStdinJson(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    // No payload after 1 s (stdin never closed): carry on without one.
    const fallback = setTimeout(() => done({}), 1000);
    const done = (val: HookPayload) => {
      if (resolved) return;
      resolved = true;
      // The fallback timer kept every hook process alive a full second
      // after its work was done — on each of several hooks per turn.
      clearTimeout(fallback);
      resolve(val);
    };
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        done(raw ? (JSON.parse(raw) as HookPayload) : {});
      } catch {
        done({});
      }
    });
    process.stdin.on('error', () => done({}));

  });
}

const HOOK_EVENTS = [
  'prompt-submit',
  'stop',
  'checkpoint',
  'checkpoint-seal',
  'status-prompt',
  'status-stop',
  'status-notify',
] as const;

/** `work hook <event>` without the yargs router (bin.ts's fast path). An
 *  unknown event is ignored: a hook must never fail Claude's turn. */
export async function runHookEvent(event: string | undefined): Promise<void> {
  if (!event || !(HOOK_EVENTS as readonly string[]).includes(event)) return;
  await handleHook(event as HookEvent);
}

export const hookCommand: CommandModule = {
  command: 'hook <event>',
  describe: false, // hidden — humans don't call this directly
  builder: (y) =>
    y.positional('event', {
      type: 'string',
      choices: HOOK_EVENTS,
      describe: 'Hook event name',
    }),
  handler: async (argv) => handleHook(argv.event as HookEvent),
};

async function handleHook(event: HookEvent): Promise<void> {
  {
    // Bail when this hook fired from one of work's OWN internal `claude -p`
    // runs (checkpoint naming, Jira slug, CLAUDE.md gen). Those headless
    // Claudes inherit the WORK_INTERNAL_CLAUDE marker; without this guard the
    // checkpoint-naming run recursively seals + spawns checkpoints, fragmenting
    // one Claude round into many spurious steps. See internal-claude.ts.
    if (isInternalClaude()) return;
    const payload = await readStdinJson();
    const cwd = payload.cwd ?? process.cwd();
    // Checkpoint bridges are independent of comment delivery: just nudge work
    // web, emit nothing to Claude's context.
    if (event === 'checkpoint') {
      await postToWeb('api/checkpoint', cwd);
      return;
    }
    if (event === 'checkpoint-seal') {
      await postToWeb('api/checkpoint/seal', cwd);
      return;
    }
    // Attention inbox: record the session's state, then nudge work web so
    // the dashboard (and desktop notification) updates immediately. Emits
    // nothing to Claude. Outside a work session it's a no-op.
    if (STATUS_EVENTS.has(event)) {
      const session = findSessionForCwd(cwd);
      const statusEvent = statusEventFor(event, payload);
      if (!session || !statusEvent) return;
      // Best-effort — never block Claude's turn on bookkeeping — but logged,
      // so "why does the inbox not show this session?" has an answer.
      const recorded = await bestEffortAsync(`record status ${event} for ${session.target}:${session.branch}`, async () => {
        await recordStatusEvent(sessionIdFor(session), statusEvent);
        return true;
      });
      if (!recorded) return;
      await postToWeb('api/status-changed', cwd);
      return;
    }
    // Claimed (= marked delivered) before printing: the process ends right
    // after this write, and a claim is what stops a PTY push racing us from
    // sending the same comments.
    const result = computeHookOutput({ event, cwd }, claimForDelivery);
    if (!result || !result.sessionId) return;
    process.stdout.write(result.stdout);
  }
}
