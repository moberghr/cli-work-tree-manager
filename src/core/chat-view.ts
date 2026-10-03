/**
 * PURE — shared by the SPA, the demo and the server; keep it import-free.
 *
 * The chat in work's own terms. An agent's headless protocol (Claude's
 * stream-json: agents/claude-chat.ts) is read by its adapter into
 * `ChatRecord`s — what was said, by whom, which tool ran — and this turns
 * them into items to draw: each tool call paired with its result, whatever
 * the tool. A line the adapter doesn't know comes as a `raw` record and is
 * shown raw, so an agent update shows up plainer, never missing.
 */

/** One thing in a chat, in work's terms (an adapter's reading of its agent's line). */
export type ChatRecord =
  /** Your message. */
  | { kind: 'you'; text: string }
  /** Tagged text an agent keeps in your message — a `!` command and its output, a slash command — one part per tag. */
  | { kind: 'tagged'; parts: Array<{ tag: string; text: string }> }
  /** The agent's text. */
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  /** A tool call; its result comes later as a `tool-result` with this id ('' when it has none: nothing can pair with it). */
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolId: string | null; text: string; isError: boolean }
  /** The end of a turn. */
  | { kind: 'turn-end'; ok: boolean; subtype: string; durationMs: number | null; costUsd: number | null }
  /** A short line: "Interrupted", "Conversation compacted". */
  | { kind: 'notice'; text: string }
  /** Something the adapter doesn't know, shown as it came. */
  | { kind: 'raw'; label: string; raw: unknown };

export interface ChatMessage {
  /** Order of arrival (history first, then live). */
  seq: number;
  /** What one line of the agent's said (a line of noise gives none and isn't kept). */
  records: ChatRecord[];
}

export type ChatItem =
  | { kind: 'user'; key: string; text: string }
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

export function chatItems(messages: readonly ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();

  for (const m of messages) {
    m.records.forEach((r, i) => {
      const key = `${m.seq}:${i}`;
      switch (r.kind) {
        case 'you':
          items.push({ kind: 'user', key, text: r.text });
          return;
        case 'tool': {
          // An id-less call is identified by its place (unique in the chat), and nothing pairs with it.
          const item: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', key, id: r.id || `@${key}`, name: r.name, input: r.input, result: null };
          if (r.id) tools.set(r.id, item);
          items.push(item);
          return;
        }
        case 'tool-result': {
          const tool = r.toolId ? tools.get(r.toolId) : undefined;
          const result = { text: r.text, isError: r.isError };
          if (tool) tool.result = result;
          else items.push({ kind: 'notice', key, text: r.text });
          return;
        }
        case 'turn-end':
          items.push({ kind: 'result', key, ok: r.ok, subtype: r.subtype, durationMs: r.durationMs, costUsd: r.costUsd });
          return;
        default:
          items.push({ ...r, key });
      }
    });
  }
  return items;
}
