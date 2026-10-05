import type { CommandModule } from 'yargs';
import { readSessionActivity } from '../core/sessions/session-activity.js';
import {
  findSessionForCwd,
  formatPendingForPrompt,
  claimForDelivery,
  readPendingForWorktree,
  sessionIdFor,
} from '../core/comments/pending-delivery.js';
import { isInternalRun } from '../core/platform/internal-run.js';
import { isOwnCheckout, ownCheckoutNote } from '../core/worktree/own-checkout.js';
import { loadConfig } from '../core/platform/config.js';
import { readWebUrl } from '../core/platform/web-discovery.js';
import { recordStatusEvent, type StatusEvent } from '../core/status/session-status.js';
import { bestEffortAsync } from '../core/platform/best-effort.js';
import { readAssistantContext } from '../core/agents/assistant.js';
import { agentById, type AgentAdapter, type TurnEdge } from '../core/agents/index.js';

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
  | 'status-notify'
  | 'assistant-context'
  /** One hook per turn edge: delivery + status + checkpoint (the full dashboard). */
  | 'turn-start'
  | 'turn-end';

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
  /** The agent that ran the hook: it says how notes are handed over (its hook output format). */
  agent: AgentAdapter = agentById('claude'),
): HookOutput | null {
  const session = findSessionForCwd(input.cwd);
  if (!session) return null;

  const activity = readSessionActivity(session);
  if (activity.state === 'stale') return null;

  const sessionId = sessionIdFor(session);
  const unclaimed = readPendingForWorktree(session);
  if (unclaimed.length === 0) return null;
  const mine = new Set(
    claim(
      sessionId,
      unclaimed.map((c) => c.id),
    ),
  );
  const pending = unclaimed.filter((c) => mine.has(c.id));
  if (pending.length === 0) return null;

  const text = formatPendingForPrompt(pending);
  if (!text) return null;

  const ids = pending.map((c) => c.id);
  // The agent's way of taking notes from a hook (Claude: added to the prompt; at Stop, `decision: block`).
  const edge = input.event === 'prompt-submit' ? 'turn-start' : 'turn-end';
  const stdout = agent.events ? agent.events.handOver(edge, text) : text + '\n';
  return { stdout, deliveredIds: ids, sessionId };
}

/** What an agent sends a hook on stdin: its own shape, read by its adapter (agents/). */
type HookPayload = Record<string, unknown>;

/** The turn edge a status hook is for. */
const STATUS_EDGE: Partial<Record<HookEvent, TurnEdge>> = {
  'status-prompt': 'turn-start',
  'status-stop': 'turn-end',
  'status-notify': 'notify',
};

/** Map a status hook + its payload to a status event, through the agent that ran it. Exported for tests. */
export function statusEventFor(event: HookEvent, payload: HookPayload, agent: AgentAdapter = agentById('claude')): StatusEvent | null {
  const edge = STATUS_EDGE[event];
  return edge && agent.events ? agent.events.read(edge, payload).status : null;
}

/** The folder a hook fired in: what the agent says, else the hook's own. */
function hookCwd(payload: HookPayload, agent: AgentAdapter): string {
  return agent.events?.read('turn-start', payload).cwd ?? (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
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
  'assistant-context',
  'turn-start',
  'turn-end',
] as const;

/** `work hook <event> [--agent <id>]` without the yargs router (bin.ts's fast path). An
 *  unknown event is ignored: a hook must never fail an agent's turn. The agent
 *  that runs it says so with --agent (Claude Code's hooks, installed before
 *  agents had a name here, don't: Claude is the default). */
export async function runHookEvent(event: string | undefined, args: readonly string[] = []): Promise<void> {
  if (!event || !(HOOK_EVENTS as readonly string[]).includes(event)) return;
  await handleHook(event as HookEvent, hookAgentArg(args));
}

/** The agent a hook names (`--agent <id>`; Claude when it names none). */
export function hookAgentArg(args: readonly string[]): string {
  const i = args.indexOf('--agent');
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : 'claude';
}

export const hookCommand: CommandModule = {
  command: 'hook <event>',
  describe: false, // hidden — humans don't call this directly
  builder: (y) =>
    y
      .positional('event', {
        type: 'string',
        choices: HOOK_EVENTS,
        describe: 'Hook event name',
      })
      .option('agent', { type: 'string', default: 'claude', describe: 'The agent running the hook' }),
  handler: async (argv) => handleHook(argv.event as HookEvent, String(argv.agent ?? 'claude')),
};

export interface TurnHookIo {
  write: (text: string) => void;
  post: (route: string, cwd: string) => Promise<void>;
  /** The own-checkout note for a folder (tests); default: from the session and config. */
  ownCheckoutNote?: (cwd: string) => string | null;
}

/** The note for a turn starting in a repo's own checkout (the session for that folder), or null. */
export function ownCheckoutNoteFor(cwd: string): string | null {
  const session = findSessionForCwd(cwd);
  if (!session || session.isGroup) return null;
  const repos = loadConfig()?.repos ?? {};
  return isOwnCheckout(session, repos) ? ownCheckoutNote(session) : null;
}

/**
 * `turn-start` / `turn-end`: what three hooks did, in one process. Pending
 * comments are written for Claude first (prompt-submit / stop output), then
 * the checkpoint nudge and the status record run side by side.
 */
export async function runTurnHook(
  start: boolean,
  payload: HookPayload,
  io: TurnHookIo = { write: (t) => void process.stdout.write(t), post: postToWeb },
  agent: AgentAdapter = agentById('claude'),
): Promise<void> {
  const cwd = hookCwd(payload, agent);
  const result = computeHookOutput({ event: start ? 'prompt-submit' : 'stop', cwd }, claimForDelivery, agent);
  if (result?.sessionId) io.write(result.stdout);
  // On a repo's own checkout: stay on its branch — branches are work's (own-checkout.ts).
  if (start) {
    const note = io.ownCheckoutNote ? io.ownCheckoutNote(cwd) : ownCheckoutNoteFor(cwd);
    if (note) io.write(note + '\n');
  }
  // A Stop that just handed Claude your comments (`decision: block`) is no
  // end of the turn: Claude goes on with them, and its real Stop comes later
  // (recorded as a stop then, so you hear when it is done).
  const handedOn = !start && !!result?.sessionId;
  await Promise.all([
    io.post(start ? 'api/checkpoint/seal' : 'api/checkpoint', cwd),
    handedOn
      ? recordStatus('status-stop', payload, cwd, io.post, { kind: 'continue', what: 'Working on the comments you sent' }, agent)
      : recordStatus(start ? 'status-prompt' : 'status-stop', payload, cwd, io.post, undefined, agent),
  ]);
}

/** Record a status event for the cwd's session and nudge work web. No-op outside a work session. */
async function recordStatus(
  event: HookEvent,
  payload: HookPayload,
  cwd: string,
  post: (route: string, cwd: string) => Promise<void> = postToWeb,
  override?: StatusEvent,
  agent: AgentAdapter = agentById('claude'),
): Promise<void> {
  const session = findSessionForCwd(cwd);
  const statusEvent = override ?? statusEventFor(event, payload, agent);
  if (!session || !statusEvent) return;
  // Best-effort — never block Claude's turn on bookkeeping — but logged,
  // so "why does the inbox not show this session?" has an answer.
  const recorded = await bestEffortAsync(`record status ${event} for ${session.target}:${session.branch}`, async () => {
    await recordStatusEvent(sessionIdFor(session), statusEvent);
    return true;
  });
  if (recorded) await post('api/status-changed', cwd);
}

async function handleHook(event: HookEvent, agentId = 'claude'): Promise<void> {
  {
    // Bail when this hook fired from one of work's OWN internal `claude -p`
    // runs (checkpoint naming, Jira slug, CLAUDE.md gen). Those headless
    // Claudes inherit the WORK_INTERNAL_CLAUDE marker; without this guard the
    // checkpoint-naming run recursively seals + spawns checkpoints, fragmenting
    // one Claude round into many spurious steps. See internal-claude.ts.
    if (isInternalRun()) return;
    const payload = await readStdinJson();
    const agent = agentById(agentId);
    const cwd = hookCwd(payload, agent);
    // The dashboard assistant's UserPromptSubmit hook (installed only in its
    // own folder): stdout becomes context for the prompt — what the user is
    // looking at in the dashboard.
    if (event === 'assistant-context') {
      const text = readAssistantContext();
      if (text) process.stdout.write(text + '\n');
      return;
    }
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
    // One hook per turn edge (the full dashboard installs these): delivery,
    // status and checkpoint in ONE process instead of three — each `work`
    // start is a node boot, for every turn of every Claude on the machine.
    // What Claude reads (pending comments) is written first; the
    // bookkeeping runs after, side by side.
    if (event === 'turn-start' || event === 'turn-end') {
      await runTurnHook(event === 'turn-start', payload, undefined, agent);
      return;
    }
    // Attention inbox: record the session's state, then nudge work web so
    // the dashboard (and desktop notification) updates immediately. Emits
    // nothing to Claude. Outside a work session it's a no-op.
    if (STATUS_EVENTS.has(event)) {
      await recordStatus(event, payload, cwd, postToWeb, undefined, agent);
      return;
    }
    // Claimed (= marked delivered) before printing: the process ends right
    // after this write, and a claim is what stops a PTY push racing us from
    // sending the same comments.
    const result = computeHookOutput({ event, cwd }, claimForDelivery, agent);
    if (!result || !result.sessionId) return;
    process.stdout.write(result.stdout);
  }
}
