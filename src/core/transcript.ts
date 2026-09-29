import fs from 'node:fs';

/**
 * Reading Claude Code transcripts (`~/.claude/projects/<dir>/<id>.jsonl`,
 * one JSON entry per line). Only a tail is read — transcripts get large —
 * so the first line of a tail may be partial and is skipped.
 */

export const TAIL_BYTES = 256 * 1024;

import type { TranscriptEntry } from './transcript-entry.js';

export { contentBlocks, type ContentBlock, type TranscriptEntry } from './transcript-entry.js';

function parseLines(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (entry && typeof entry === 'object') out.push(entry as TranscriptEntry);
    } catch {
      // partial first line, or a line being written right now
    }
  }
  return out;
}

/** The parsed entries in the last `bytes` of a transcript, oldest first.
 *  [] when unreadable. */
export function readTranscriptTail(transcriptPath: string | undefined, bytes = TAIL_BYTES): TranscriptEntry[] {
  if (!transcriptPath) return [];
  let text: string;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  return parseLines(text);
}

export interface TranscriptWindow {
  /** Oldest first; may start before `sinceMs` (the caller filters). */
  entries: TranscriptEntry[];
  /** The file's earlier part was left unread: `maxBytes` ran out before an
   *  entry older than `sinceMs` turned up, so earlier entries in the
   *  window are missing. */
  partial: boolean;
}

/** First read; doubled until the window is covered. */
export const SINCE_CHUNK_BYTES = 2 * 1024 * 1024;
/** The most one transcript is read for a window. */
export const SINCE_MAX_BYTES = 64 * 1024 * 1024;

const entryMs = (e: TranscriptEntry): number => (typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN);

/**
 * Every entry at or after `sinceMs`: reads the file from its end in growing
 * chunks until an entry older than that shows up (or the file's start), so
 * a busy day's morning is never silently cut off by a fixed tail. Async —
 * the digest reads many of these per request and must not stall the
 * event loop (terminal relays, hooks). [] + not partial when unreadable.
 */
export async function readTranscriptSince(
  transcriptPath: string,
  sinceMs: number,
  opts: { chunkBytes?: number; maxBytes?: number } = {},
): Promise<TranscriptWindow> {
  const chunk = Math.max(1, opts.chunkBytes ?? SINCE_CHUNK_BYTES);
  const max = Math.max(chunk, opts.maxBytes ?? SINCE_MAX_BYTES);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
  } catch {
    return { entries: [], partial: false };
  }
  try {
    const size = (await fh.stat()).size;
    let bytes = Math.min(chunk, size);
    for (;;) {
      const start = size - bytes;
      const buf = Buffer.alloc(bytes);
      await fh.read(buf, 0, bytes, start);
      const entries = parseLines(buf.toString('utf-8'));
      const earliest = entries.map(entryMs).find((ms) => Number.isFinite(ms));
      if (start === 0 || (earliest !== undefined && earliest < sinceMs)) return { entries, partial: false };
      if (bytes >= max) return { entries, partial: true };
      bytes = Math.min(size, bytes * 2, max);
    }
  } catch {
    return { entries: [], partial: false };
  } finally {
    await fh.close();
  }
}
