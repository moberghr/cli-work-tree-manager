/**
 * PURE — shared by the SPA, the demo and the server; keep it import-free.
 *
 * Turns headless Claude Code's stream-json messages (the same shapes its
 * transcripts hold) into items to draw. It renders the PROTOCOL, not
 * Claude's features: a tool call is a tool call whatever the tool, a content
 * block of an unknown type is shown raw, and a top-level message type we
 * don't know is shown raw too — so a Claude update shows up here plainer,
 * never missing. Only messages known to be noise (status pings, rate-limit
 * info, …) are left out.
 */

export interface ChatMessage {
  /** Order of arrival (history first, then live). */
  seq: number;
  /** One stream-json line (or transcript entry), as Claude wrote it. */
  raw: unknown;
}

export type ChatItem =
  | { kind: 'user'; key: string; text: string }
  /** Tagged text Claude Code stores in a user message — a `!` command and its
   *  output (<bash-input>, <bash-stdout>), a slash command (<command-name>),
   *  … — one part per tag, whatever the tag. */
  | { kind: 'tagged'; key: string; parts: Array<{ tag: string; text: string }> }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      id: string;
      name: string;
      input: unknown;
      result: { text: string; isError: boolean } | null;
    }
  | { kind: 'result'; key: string; ok: boolean; subtype: string; durationMs: number | null; costUsd: number | null }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'raw'; key: string; label: string; raw: unknown };

/** Top-level messages that carry nothing to read. */
const NOISE_TYPES = new Set(['stream_event', 'rate_limit_event', 'control_response', 'control_request', 'keep_alive']);
const NOISE_SYSTEM = new Set(['init', 'status', 'thinking_tokens', 'hook_started', 'hook_response', 'hook_progress']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Terminal colour and cursor codes, which read as garbage outside a terminal. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

const TAGGED = /<([a-z][\w-]*)>([\s\S]*?)<\/\1>/g;

/** Splits `<tag>…</tag>` segments out of a message's text; the rest stays plain. */
export function splitTagged(text: string): { plain: string; parts: Array<{ tag: string; text: string }> } {
  const parts: Array<{ tag: string; text: string }> = [];
  const plain = text.replace(TAGGED, (_m, tag: string, body: string) => {
    parts.push({ tag, text: stripAnsi(body).trim() });
    return '';
  });
  return { plain: plain.trim(), parts };
}

/** A tool_result's content as text (string, or text blocks; other blocks named). */
export function resultText(content: unknown): string {
  return stripAnsi(rawResultText(content));
}

function rawResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b) => (isObj(b) ? (b.type === 'text' ? str(b.text) ?? '' : `[${str(b.type) ?? 'block'}]`) : ''))
    .join('\n');
}

function blocksOf(message: unknown): unknown[] {
  if (!isObj(message)) return [];
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

export function chatItems(messages: readonly ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();

  for (const m of messages) {
    const raw = m.raw;
    if (!isObj(raw)) continue;
    const type = str(raw.type) ?? '';
    if (NOISE_TYPES.has(type)) continue;
    if (raw.isMeta === true || raw.isSidechain === true) continue;

    if (type === 'user') {
      blocksOf(raw.message).forEach((b, i) => {
        if (!isObj(b)) return;
        const key = `${m.seq}:${i}`;
        if (b.type === 'tool_result') {
          const id = str(b.tool_use_id);
          const tool = id ? tools.get(id) : undefined;
          const result = { text: resultText(b.content), isError: b.is_error === true };
          if (tool) tool.result = result;
          else items.push({ kind: 'notice', key, text: result.text });
        } else if (b.type === 'text') {
          const text = str(b.text) ?? '';
          if (!text.trim()) return;
          if (/^\[Request interrupted by user/.test(text)) {
            items.push({ kind: 'notice', key, text: 'Interrupted' });
            return;
          }
          const { plain, parts } = splitTagged(text);
          if (parts.length) items.push({ kind: 'tagged', key, parts });
          if (plain) items.push({ kind: 'user', key: parts.length ? `${key}:plain` : key, text: stripAnsi(plain) });
        } else {
          items.push({ kind: 'raw', key, label: `user ${str(b.type) ?? 'block'}`, raw: b });
        }
      });
      continue;
    }

    if (type === 'assistant') {
      blocksOf(raw.message).forEach((b, i) => {
        if (!isObj(b)) return;
        const key = `${m.seq}:${i}`;
        if (b.type === 'text') {
          const text = stripAnsi(str(b.text) ?? '');
          if (text.trim()) items.push({ kind: 'text', key, text });
        } else if (b.type === 'thinking') {
          const text = str(b.thinking) ?? '';
          if (text.trim()) items.push({ kind: 'thinking', key, text });
        } else if (b.type === 'redacted_thinking') {
          // nothing readable
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const id = str(b.id) ?? key;
          const item: Extract<ChatItem, { kind: 'tool' }> = {
            kind: 'tool',
            key,
            id,
            name: str(b.name) ?? 'tool',
            input: b.input,
            result: null,
          };
          tools.set(id, item);
          items.push(item);
        } else {
          items.push({ kind: 'raw', key, label: str(b.type) ?? 'block', raw: b });
        }
      });
      continue;
    }

    const key = `${m.seq}`;
    if (type === 'result') {
      items.push({
        kind: 'result',
        key,
        ok: raw.is_error !== true && str(raw.subtype) === 'success',
        subtype: str(raw.subtype) ?? '',
        durationMs: num(raw.duration_ms),
        costUsd: num(raw.total_cost_usd),
      });
      continue;
    }
    if (type === 'system') {
      const subtype = str(raw.subtype) ?? '';
      if (NOISE_SYSTEM.has(subtype)) continue;
      if (subtype === 'compact_boundary') items.push({ kind: 'notice', key, text: 'Conversation compacted' });
      else items.push({ kind: 'raw', key, label: `system ${subtype}`, raw });
      continue;
    }
    items.push({ kind: 'raw', key, label: type || 'message', raw });
  }
  return items;
}
