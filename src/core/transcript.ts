import fs from 'node:fs';

/**
 * Reading Claude Code transcripts (`~/.claude/projects/<dir>/<id>.jsonl`,
 * one JSON entry per line). Only the file's tail is read — transcripts get
 * large — so the first line of a tail may be partial and is skipped.
 */

export const TAIL_BYTES = 256 * 1024;

import type { TranscriptEntry } from './transcript-entry.js';

export { contentBlocks, type ContentBlock, type TranscriptEntry } from './transcript-entry.js';

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
