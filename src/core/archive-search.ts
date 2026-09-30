import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveSearchHit } from './api-types.js';
import { contentBlocks, type TranscriptEntry } from './transcript-entry.js';
import { archiveRoot, readArchive } from './session-archive.js';

/**
 * "What did we do about X?" over archived sessions: every word of the query
 * must appear in one message (yours or Claude's) of a kept conversation.
 * Reads the archive's transcript copies asynchronously, so a search doesn't
 * hold up the server (and its terminal relays).
 */

const MAX_SESSIONS = 20;
const SNIPPETS_PER_SESSION = 3;
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

export async function searchArchives(query: string, root = archiveRoot()): Promise<ArchiveSearchHit[]> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  let ids: string[];
  try {
    ids = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const hits: ArchiveSearchHit[] = [];
  for (const id of ids) {
    const rec = readArchive(id, root);
    if (!rec) continue;
    const snippets: ArchiveSearchHit['snippets'] = [];
    for (const t of rec.transcripts) {
      if (snippets.length >= SNIPPETS_PER_SESSION) break;
      let raw: string;
      try {
        raw = await fs.promises.readFile(path.join(root, id, 'transcripts', t.file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (snippets.length >= SNIPPETS_PER_SESSION) break;
        if (!line) continue;
        const lower = line.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue; // cheap pre-filter on the raw JSON line
        let e: TranscriptEntry;
        try {
          e = JSON.parse(line) as TranscriptEntry;
        } catch {
          continue;
        }
        const m = entryText(e);
        if (!m || !words.every((w) => m.text.toLowerCase().includes(w))) continue;
        snippets.push({ role: m.role, text: snippet(m.text, words), at: typeof e.timestamp === 'string' ? e.timestamp : null });
      }
    }
    if (snippets.length) hits.push({ sessionId: id, target: rec.target, branch: rec.branch, archivedAt: rec.archivedAt, worktreeRemoved: rec.worktreeRemoved, snippets });
    if (hits.length >= MAX_SESSIONS) break;
  }
  return hits.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
