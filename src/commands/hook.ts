import type { CommandModule } from 'yargs';
import { readSessionActivity } from '../core/claude-activity.js';
import {
  findSessionForCwd,
  formatPendingForPrompt,
  markDelivered,
  readPendingForSession,
  sessionIdFor,
} from '../core/pending-delivery.js';

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
export type HookEvent = 'prompt-submit' | 'stop';

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
export function computeHookOutput(input: HookInput): HookOutput | null {
  const session = findSessionForCwd(input.cwd);
  if (!session) return null;

  const activity = readSessionActivity(session);
  if (activity.state === 'stale') return null;

  const sessionId = sessionIdFor(session);
  const pending = readPendingForSession(sessionId);
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
}

async function readStdinJson(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    const done = (val: HookPayload) => {
      if (resolved) return;
      resolved = true;
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
    setTimeout(() => done({}), 1000);
  });
}

export const hookCommand: CommandModule = {
  command: 'hook <event>',
  describe: false, // hidden — humans don't call this directly
  builder: (y) =>
    y.positional('event', {
      type: 'string',
      choices: ['prompt-submit', 'stop'] as const,
      describe: 'Hook event name',
    }),
  handler: async (argv) => {
    const event = argv.event as HookEvent;
    const payload = await readStdinJson();
    const cwd = payload.cwd ?? process.cwd();
    const result = computeHookOutput({ event, cwd });
    if (!result || !result.sessionId) return;
    process.stdout.write(result.stdout);
    markDelivered(result.sessionId, result.deliveredIds);
  },
};
