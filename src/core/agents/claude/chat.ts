import fs from 'node:fs';
import path from 'node:path';
import { splitTagged, stripAnsi, type ChatRecord } from '../../chat/chat-view.js';
import { readTranscriptTail } from './transcript.js';
import { latestTranscript } from './files.js';
import type { AgentChat, ChatLineRead, ChatPermissionTool } from '../types.js';

/**
 * Claude Code's headless chat (types.ts `AgentChat`): `claude -p` with
 * stream-json in and out, kept running between turns. Your message is a
 * `user` line on stdin, an interrupt a `control_request` (the Agent SDK's
 * protocol); every line it prints is read here into work's terms
 * (`ChatRecord`s, chat-view.ts) — its transcripts hold the same shapes, so
 * the history before it runs is read the same way.
 *
 * Permission prompts reach work through Claude's documented
 * --permission-prompt-tool: an MCP tool work web serves (chat-mcp-routes.ts)
 * at the URL `open` is given, named in an MCP config file written here.
 */

/** The permission tool's name as Claude calls it (server `work_chat`, tool `approve`). */
export const PERMISSION_TOOL = 'mcp__work_chat__approve';

/**
 * Claude's permission prompt tool (--permission-prompt-tool, an MCP tool):
 * it is sent the tool Claude wants to run and its input, and answers
 * `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.
 */
export const claudePermissionTool: ChatPermissionTool = {
  tool: {
    name: 'approve',
    description: 'Ask the user whether a tool call may run.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
  },
  request: (args) => ({
    toolName: typeof args.tool_name === 'string' ? args.tool_name : 'tool',
    input: args.input ?? {},
    toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
  }),
  reply: (d) => (d.allow ? { behavior: 'allow', updatedInput: d.input ?? {} } : { behavior: 'deny', message: d.message ?? 'The user denied this.' }),
};

/** How much of the newest transcript the chat shows before it runs. */
const HISTORY_BYTES = 1024 * 1024;

/** Top-level messages that carry nothing to read. */
const NOISE_TYPES = new Set(['stream_event', 'rate_limit_event', 'control_response', 'control_request', 'keep_alive']);
const NOISE_SYSTEM = new Set(['init', 'status', 'thinking_tokens', 'hook_started', 'hook_response', 'hook_progress']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A tool_result's content as text (string, or text blocks; other blocks named), without terminal codes. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return stripAnsi(content);
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return stripAnsi(content.map((b) => (isObj(b) ? (b.type === 'text' ? str(b.text) ?? '' : `[${str(b.type) ?? 'block'}]`) : '')).join('\n'));
}

function blocksOf(message: unknown): unknown[] {
  if (!isObj(message)) return [];
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

/**
 * PURE: one stream-json line (or transcript entry) as chat records. It reads
 * the protocol, not Claude's features: a tool call is a tool call whatever
 * the tool, and a block or message type it doesn't know comes back `raw`.
 * Known noise (status pings, rate-limit info, meta and subagent entries)
 * gives none.
 */
export function claudeChatRecords(raw: unknown): ChatRecord[] {
  if (!isObj(raw)) return [];
  const type = str(raw.type) ?? '';
  if (NOISE_TYPES.has(type)) return [];
  if (raw.isMeta === true || raw.isSidechain === true) return [];
  const out: ChatRecord[] = [];

  if (type === 'user') {
    for (const b of blocksOf(raw.message)) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') {
        out.push({ kind: 'tool-result', toolId: str(b.tool_use_id), text: resultText(b.content), isError: b.is_error === true });
      } else if (b.type === 'text') {
        const text = str(b.text) ?? '';
        if (!text.trim()) continue;
        if (/^\[Request interrupted by user/.test(text)) {
          out.push({ kind: 'notice', text: 'Interrupted' });
          continue;
        }
        // A `!` command and its output, a slash command: Claude Code keeps them as tags in your message.
        const { plain, parts } = splitTagged(text);
        if (parts.length) out.push({ kind: 'tagged', parts });
        if (plain) out.push({ kind: 'you', text: stripAnsi(plain) });
      } else {
        out.push({ kind: 'raw', label: `user ${str(b.type) ?? 'block'}`, raw: b });
      }
    }
    return out;
  }

  if (type === 'assistant') {
    for (const b of blocksOf(raw.message)) {
      if (!isObj(b)) continue;
      if (b.type === 'text') {
        const text = stripAnsi(str(b.text) ?? '');
        if (text.trim()) out.push({ kind: 'text', text });
      } else if (b.type === 'thinking') {
        const text = str(b.thinking) ?? '';
        if (text.trim()) out.push({ kind: 'thinking', text });
      } else if (b.type === 'redacted_thinking') {
        // nothing readable
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        // No id (never seen, but possible): '' — no result can name it, and the view keys it by place.
        out.push({ kind: 'tool', id: str(b.id) ?? '', name: str(b.name) ?? 'tool', input: b.input });
      } else {
        out.push({ kind: 'raw', label: str(b.type) ?? 'block', raw: b });
      }
    }
    return out;
  }

  if (type === 'result') {
    return [{ kind: 'turn-end', ok: raw.is_error !== true && str(raw.subtype) === 'success', subtype: str(raw.subtype) ?? '', durationMs: num(raw.duration_ms), costUsd: num(raw.total_cost_usd) }];
  }
  if (type === 'system') {
    const subtype = str(raw.subtype) ?? '';
    if (NOISE_SYSTEM.has(subtype)) return [];
    return [subtype === 'compact_boundary' ? { kind: 'notice', text: 'Conversation compacted' } : { kind: 'raw', label: `system ${subtype}`, raw }];
  }
  return [{ kind: 'raw', label: type || 'message', raw }];
}

/** PURE: one line headless Claude printed, in work's terms: what to show, and what it says about the run. */
export function claudeChatRead(raw: unknown): ChatLineRead {
  if (!isObj(raw)) return { records: [] };
  switch (raw.type) {
    case 'stream_event':
      return { records: [], stream: streamOf(raw.event) };
    case 'control_response':
      return { records: [], acknowledged: true };
    case 'system':
      return { records: claudeChatRecords(raw), ready: true, ...(raw.subtype === 'init' && typeof raw.session_id === 'string' ? { conversationId: raw.session_id } : {}) };
    case 'result':
      return { records: claudeChatRecords(raw), turnEnded: true };
    case 'assistant':
    case 'user':
      return { records: claudeChatRecords(raw), activity: true };
    default:
      return { records: claudeChatRecords(raw) };
  }
}

/** Only the block being written right now is streamed; finished blocks arrive as messages. */
function streamOf(ev: unknown): ChatLineRead['stream'] {
  if (!isObj(ev)) return undefined;
  if (ev.type === 'content_block_start') {
    const kind = isObj(ev.content_block) && typeof ev.content_block.type === 'string' ? ev.content_block.type : 'text';
    return { start: kind === 'text' || kind === 'thinking' ? kind : null };
  }
  if (ev.type === 'content_block_delta') {
    const d = isObj(ev.delta) ? ev.delta : {};
    const add = typeof d.text === 'string' ? d.text : typeof d.thinking === 'string' ? d.thinking : '';
    return add ? { delta: add } : undefined;
  }
  if (ev.type === 'content_block_stop' || ev.type === 'message_stop') return { stop: true };
  return undefined;
}

/** The MCP config file pointing Claude at work's permission tool (under ~/.work/chat). */
export function writeMcpConfig(dir: string, sessionId: string, url: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.mcp.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { work_chat: { type: 'http', url } } }, null, 2));
  return file;
}

export const claudeChat: AgentChat = {
  open({ sessionId, permissionUrl, dir }) {
    const mcpConfig = writeMcpConfig(dir, sessionId, permissionUrl);
    return {
      args: ({ resumeId, continueLatest }) => [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--replay-user-messages',
        '--permission-prompts', 'host',
        '--permission-prompt-tool', PERMISSION_TOOL,
        '--mcp-config', mcpConfig,
        ...(resumeId ? ['--resume', resumeId] : continueLatest ? ['--continue'] : []),
      ],
      userLine: (text) => ({ type: 'user', message: { role: 'user', content: text } }),
      interruptLine: () => ({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } }),
      read: claudeChatRead,
      permissionTool: claudePermissionTool,
    };
  },
  history(session) {
    const file = latestTranscript(session)?.file;
    // A transcript holds more than the conversation (file snapshots, summaries, …): only its messages and compactions.
    return readTranscriptTail(file, HISTORY_BYTES)
      .filter((e) => e.type === 'user' || e.type === 'assistant' || (e.type === 'system' && e.subtype === 'compact_boundary'))
      .map((e) => claudeChatRecords(e))
      .filter((r) => r.length > 0);
  },
};
