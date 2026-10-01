import { contentBlocks, type TranscriptEntry } from './transcript-entry.js';

/**
 * Matching a query in a Claude transcript: every word of the query must
 * appear in one message (yours or Claude's). Used by the conversation search
 * (conversation-store.ts) over kept and archived conversations.
 */

const SNIPPET_CHARS = 220;

/** The readable text of one transcript line: your prompt, or Claude's text. */
export function entryText(e: TranscriptEntry): { role: 'you' | 'claude'; text: string } | null {
  if (e.isMeta === true || e.isSidechain === true) return null;
  if (e.type !== 'user' && e.type !== 'assistant') return null;
  const text = contentBlocks(e)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!text || text.startsWith('<')) return null; // tagged command echoes, reminders
  return { role: e.type === 'user' ? 'you' : 'claude', text };
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
): Array<{ role: 'you' | 'claude'; text: string; at: string | null }> {
  const out: Array<{ role: 'you' | 'claude'; text: string; at: string | null }> = [];
  if (max <= 0) return out;
  for (const line of raw.split('\n')) {
    if (out.length >= max) break;
    if (!line) continue;
    const lower = line.toLowerCase();
    if (!jsonWords.every((w) => lower.includes(w))) continue; // cheap pre-filter on the raw JSON line
    let e: TranscriptEntry;
    try {
      e = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const m = entryText(e);
    if (!m || !words.every((w) => m.text.toLowerCase().includes(w))) continue;
    out.push({ role: m.role, text: snippet(m.text, words), at: typeof e.timestamp === 'string' ? e.timestamp : null });
  }
  return out;
}
