import fs from 'node:fs';
import { listTranscripts } from './context-usage.js';
import { promptsSince } from './digest.js';
import type { WorktreeSession } from './session-types.js';
import type { TranscriptEntry } from './transcript-entry.js';

/**
 * A human name for a session, beside its branch: the name you gave it, or
 * else what you first asked its Claude ("Rotate the terminal encryption
 * keys"), or else its Jira key. Worked out when read — the first prompt is
 * read from the start of its oldest transcript, cached per file — so a GET
 * writes nothing; only a rename is stored.
 */

const TITLE_CHARS = 80;
const HEAD_BYTES = 256 * 1024;
const cache = new Map<string, { size: number; title: string | null }>();

/** The first prompt in a transcript file (read from its start). */
export function firstPromptOf(file: string): string | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  // The start of a file doesn't change as it grows, unless it was replaced
  // (smaller). "No prompt in it" holds as long as the file is the same, or
  // its whole head was read already: re-reading 256 KB of every such
  // transcript on every session-list build cost the most of all.
  if (hit && size >= hit.size && (hit.title !== null || size === hit.size || hit.size >= HEAD_BYTES)) return hit.title;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      /* the last, cut-off line */
    }
  }
  const first = promptsSince([entries], 0)[0]?.text ?? null;
  const readable = first ? titleText(first) : null;
  const title = readable ? clip(readable) : null;
  cache.set(file, { size, title });
  return title;
}

const clip = (s: string) => (s.length > TITLE_CHARS ? s.slice(0, TITLE_CHARS - 1).trimEnd() + '…' : s);

/**
 * A prompt as a name: what you wrote, without markup. A pasted block
 * (`<pasted_content …>…</pasted_content>`, a log or code you pasted) is left
 * out when you also wrote something; a prompt that is only a paste keeps its
 * text. Other tags are dropped, their text kept. Null when nothing is left.
 */
export function titleText(prompt: string): string | null {
  const flat = (s: string) => s.replace(/<\/?[A-Za-z][\w-]*(?:\s[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim();
  const outside = flat(prompt.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, ' '));
  const text = outside || flat(prompt);
  return text ? text : null;
}

/** The session's name: yours, else its first prompt, else its Jira key. */
export function sessionTitle(s: WorktreeSession, fallbackPrompt?: string | null): string | null {
  if (s.title?.trim()) return s.title.trim();
  const oldestFirst = listTranscripts(s).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const t of oldestFirst) {
    const p = firstPromptOf(t.file);
    if (p) return p;
  }
  const fallback = fallbackPrompt ? titleText(fallbackPrompt) : null;
  if (fallback) return clip(fallback);
  return s.jiraKey ?? null;
}
