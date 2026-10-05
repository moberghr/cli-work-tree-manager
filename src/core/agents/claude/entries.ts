import { contentBlocks, type TranscriptEntry } from './transcript-entry.js';
import type { ConversationEntry } from '../types.js';

/**
 * Claude Code's transcript lines (~/.claude/projects/<folder>/<id>.jsonl) as
 * conversation entries (types.ts) — the one place work reads Claude's line
 * format. Pure (no I/O): shared by everything that reads a conversation.
 */

/** Text Claude Code writes as a "user" line that you didn't type: slash
 *  command echoes, the local-command caveat, subagent task notifications,
 *  the "[Request interrupted by user]" marker. */
const NOT_TYPED =
  /^\s*(<command-name>|<command-message>|<local-command-|<system-reminder>|<bash-|<task-notification>|\[Request interrupted|Caveat: )/;

/** The text you typed, when this line is one of your prompts (not a tool result, echo, meta or subagent line). */
export function promptText(e: TranscriptEntry): string | null {
  if (e.type !== 'user' || e.isSidechain === true || e.isMeta === true) return null;
  const blocks = contentBlocks(e);
  // A tool result is Claude's own loop, not you.
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text || NOT_TYPED.test(text)) return null;
  return text;
}

const MAX_TOOL_DETAIL = 400;

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** The part of a tool call a person needs to judge it. */
export function describeToolUse(tool: string, input: unknown): string {
  const detail =
    (tool === 'Bash' || tool === 'PowerShell' ? str(input, 'command') : undefined) ??
    str(input, 'file_path') ??
    str(input, 'notebook_path') ??
    str(input, 'url') ??
    str(input, 'query') ??
    str(input, 'pattern') ??
    str(input, 'description') ??
    (input && typeof input === 'object' ? JSON.stringify(input) : '');
  const flat = detail.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
  return flat.length > MAX_TOOL_DETAIL ? flat.slice(0, MAX_TOOL_DETAIL - 1) + '…' : flat;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A slash command you typed between turns (`/model`, `/clear`, `/exit`,
 * `/compact`) and its output: written as user lines, but no turn — Claude
 * doesn't work on them. A `!` command (`<bash-input>`) and a background
 * task's result (`<task-notification>`) are turns.
 */
function isCommandEcho(e: TranscriptEntry): boolean {
  const text = contentBlocks(e)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trimStart();
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(text);
}

/** Claude Code's own lines: meta, a compaction summary, one shown only in the transcript view. */
const isMetaLine = (e: TranscriptEntry) => e.isMeta === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true;

/** One transcript line's entries: each line gives at least one. One with no time keeps `at: ''` (search and context usage read it; what counts time skips it). */
function lineEntries(e: TranscriptEntry): ConversationEntry[] {
  const at = typeof e.timestamp === 'string' ? e.timestamp : '';
  const meta = isMetaLine(e);
  const base = {
    at,
    ...(typeof e.uuid === 'string' && e.uuid ? { id: e.uuid } : {}),
    ...(e.isSidechain === true ? { sidechain: true as const } : {}),
    ...(meta ? { meta: true as const } : {}),
  };
  // A compaction summary is written as a user line, but you didn't type it.
  const prompt = meta ? null : promptText(e);
  if (prompt) return [{ ...base, role: 'you', text: prompt }];
  const blocks = contentBlocks(e);
  if (e.type === 'user' && blocks.some((b) => b.type === 'tool_result')) return [{ ...base, role: 'tool-result', text: '' }];
  // Any other line of yours that isn't a slash command's echo is a turn's work: a `!` command, its output, a task's result.
  if (e.type === 'user') return [{ ...base, role: 'other', text: '', ...(!meta && !isCommandEcho(e) ? { turn: true as const } : {}) }];
  if (e.type !== 'assistant') return [{ ...base, role: 'other', text: '' }];

  const out: ConversationEntry[] = [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const u = e.message?.usage;
  const usage =
    u && typeof u === 'object'
      ? { prompt: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), reply: num(u.output_tokens) }
      : null;
  const model = typeof e.message?.model === 'string' ? e.message.model : undefined;
  // A meta line (Claude Code's own) is Claude's line for work time, but no message of its.
  out.push({
    ...base,
    role: 'agent',
    text: meta ? '' : text,
    ...(usage && usage.prompt + usage.reply > 0 ? { usage } : {}),
    ...(model ? { model } : {}),
  });
  for (const b of blocks) {
    if (b.type === 'tool_use' && typeof b.name === 'string')
      out.push({ ...base, role: 'tool', tool: b.name, text: describeToolUse(b.name, b.input) });
  }
  return out;
}

/** Claude transcript lines (parsed JSON, in file order) as conversation entries. */
export function claudeEntries(lines: readonly unknown[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const l of lines) if (l && typeof l === 'object') out.push(...lineEntries(l as TranscriptEntry));
  return out;
}

/** Claude's standard window, and the 1M one: a `[1m]` model id, or usage no 200k window could hold. */
export const DEFAULT_WINDOW = 200_000;
export const LARGE_WINDOW = 1_000_000;
export function claudeContextWindow(model: string | undefined, used: number): number {
  return (model && /\[1m\]/i.test(model)) || used > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW;
}
