import type { ConversationEntry } from '../agents/types.js';

/**
 * Matching a query in a conversation: every word of the query must appear
 * in one message (yours or its agent's). Used by the conversation search
 * (conversation-store.ts) over kept and archived conversations; the lines
 * are read through the session's agent (agents/: `entries`).
 */

const SNIPPET_CHARS = 220;

/** A readable message: your prompt, or the agent's text — not tool calls, results, a subagent's lines or tagged echoes. */
export function messageOf(e: ConversationEntry): { role: 'you' | 'claude'; text: string } | null {
  if (e.sidechain || (e.role !== 'you' && e.role !== 'agent')) return null;
  const text = e.text.trim();
  if (!text || text.startsWith('<')) return null; // tagged command echoes, reminders
  return { role: e.role === 'you' ? 'you' : 'claude', text };
}

/** The part of `text` around the first query word, one line. */
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0]));
  const start = Math.max(0, at - 60);
  const cut = flat.slice(start, start + SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + cut + (start + SNIPPET_CHARS < flat.length ? '…' : '');
}

/** A query's words, lower case, and as JSON writes them (`\` and `"` escaped) for the raw-line pre-filter. */
export function queryWords(query: string): { words: string[]; jsonWords: string[] } {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  return { words, jsonWords: words.map((w) => JSON.stringify(w).slice(1, -1)) };
}

/** Up to `max` messages of a transcript's text in which every word appears (yours or Claude's). */
export function matchingLines(
  raw: string,
  words: string[],
  jsonWords: string[],
  max: number,
  entries: (lines: readonly unknown[]) => ConversationEntry[],
): Array<{ role: 'you' | 'claude'; text: string; at: string | null }> {
  const out: Array<{ role: 'you' | 'claude'; text: string; at: string | null }> = [];
  if (max <= 0) return out;
  for (const line of raw.split('\n')) {
    if (out.length >= max) break;
    if (!line) continue;
    const lower = line.toLowerCase();
    if (!jsonWords.every((w) => lower.includes(w))) continue; // cheap pre-filter on the raw JSON line
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of entries([parsed])) {
      const m = messageOf(e);
      if (!m || !words.every((w) => m.text.toLowerCase().includes(w))) continue;
      out.push({ role: m.role, text: snippet(m.text, words), at: e.at || null });
      break; // one hit per line
    }
  }
  return out;
}
