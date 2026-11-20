import type { WorktreeSession } from '../../sessions/session-types.js';
import { listTranscripts } from './files.js';
import { readTranscriptTail } from './transcript.js';

/**
 * Background commands a Claude conversation started and that haven't ended,
 * from its transcript — what keeps idle sleep away from a Claude whose prompt
 * is free while a build, a test run or a dev server it started goes on
 * (stopping the Claude stops those: they're its children).
 *
 * Claude Code writes a background command as a tool call with
 * `run_in_background`; its result says `Command running in background with
 * ID: <task id>`; its end comes back as a `<task-notification>` naming the
 * call (`<tool-use-id>`) and the task (`<task-id>`); a stop is a `TaskStop`
 * (`KillShell` / `KillBash` before) naming the task. Started, not ended, not
 * stopped: running. A call that failed (its result an error) never ran.
 *
 * `sinceMs`: only calls made after it — the Claude process's start: a
 * restarted Claude lost its old background commands without a word, and they
 * mustn't keep it awake forever. Pure; returns the calls' ids.
 */
export function openBackgroundCommands(lines: readonly unknown[], sinceMs = 0): string[] {
  return openBackgroundCommandInfo(lines, sinceMs).map((c) => c.id);
}

/** What a background call is, in a line: the agent's own description of it, else the command's first line. */
function whatOf(input: Record<string, unknown>): string | null {
  const pick = [input.description, input.command].find((v): v is string => typeof v === 'string' && !!v.trim());
  if (!pick) return null;
  const line = pick.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/** The same, with what each one is (`what`: its description, else its command; null when it gives neither), in the order started. */
export function openBackgroundCommandInfo(lines: readonly unknown[], sinceMs = 0): { id: string; what: string | null }[] {
  const started = new Map<string, string | null>(); // tool-use id → task id
  const whats = new Map<string, string | null>();
  const ended = new Set<string>(); // tool-use ids
  const endedTasks = new Set<string>();
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const l = line as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    // An end notice counts wherever Claude Code wrote it: queued (`queue-operation`, a `queued_command`
    // attachment), delivered in a message, or in an `api-request-blob` — one finished command's was only there.
    const raw = JSON.stringify(line);
    if (raw.includes('<task-notification>')) {
      for (const m of raw.matchAll(/<tool-use-id>\s*([^<\s\\"]+)/g)) ended.add(m[1]);
      for (const m of raw.matchAll(/<task-id>\s*([^<\s\\"]+)/g)) endedTasks.add(m[1]);
    }
    // Starts and results from the conversation's own lines only: the `api-request-blob` copies of earlier messages
    // made a call stopped since read as started again (59 of 259 looked open in a real transcript).
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    const at = typeof l.timestamp === 'string' ? Date.parse(l.timestamp) : NaN;
    const content = l.message?.content;
    const blocks: unknown[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const block = b as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
        text?: unknown;
      };
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const bg = input.run_in_background;
        // Seen again (a resumed conversation repeats it): what's known of it stays.
        if ((bg === true || bg === 'true') && !(at < sinceMs) && !started.has(block.id)) {
          started.set(block.id, null);
          whats.set(block.id, whatOf(input));
        }
        if (block.name === 'TaskStop' || block.name === 'KillShell' || block.name === 'KillBash') {
          for (const k of ['task_id', 'shell_id', 'bash_id']) if (typeof input[k] === 'string') endedTasks.add(input[k] as string);
        }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && started.has(block.tool_use_id)) {
        if (block.is_error === true) ended.add(block.tool_use_id);
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const task = /running in background with ID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
        if (task) started.set(block.tool_use_id, task);
      }
    }
  }
  return [...started]
    .filter(([use, task]) => !ended.has(use) && !(task && endedTasks.has(task)))
    .map(([use]) => ({ id: use, what: whats.get(use) ?? null }));
}

/** How much of the newest transcript is read: a long session's start may be beyond it (the process check covers that). */
const TAIL_BYTES = 4 * 1024 * 1024;

/** Background commands the session's newest conversation started since `sinceMs` and that are still running. */
export function backgroundCommandsRunning(session: WorktreeSession, sinceMs: number): number {
  return openIn(session, sinceMs).length;
}

/** What those are, newest first (one that says nothing of itself left out): "Run the backend tests". */
export function backgroundCommandNames(session: WorktreeSession, sinceMs: number): string[] {
  return openIn(session, sinceMs)
    .map((c) => c.what)
    .filter((w): w is string => !!w)
    .reverse();
}

/** The last answer per conversation file: the session list asks while a command runs, and the tail is megabytes. */
const kept = new Map<string, { size: number; mtimeMs: number; sinceMs: number; open: { id: string; what: string | null }[] }>();

function openIn(session: WorktreeSession, sinceMs: number): { id: string; what: string | null }[] {
  const newest = listTranscripts(session).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!newest || newest.mtimeMs < sinceMs) return [];
  const had = kept.get(newest.file);
  if (had && had.size === newest.size && had.mtimeMs === newest.mtimeMs && had.sinceMs === sinceMs) return had.open;
  const open = openBackgroundCommandInfo(readTranscriptTail(newest.file, TAIL_BYTES), sinceMs);
  if (kept.size > 200) kept.clear();
  kept.set(newest.file, { size: newest.size, mtimeMs: newest.mtimeMs, sinceMs, open });
  return open;
}
