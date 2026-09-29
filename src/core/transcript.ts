import fs from 'node:fs';

/**
 * Reading Claude Code transcripts (`~/.claude/projects/<dir>/<id>.jsonl`,
 * one JSON entry per line). Only the file's tail is read — transcripts get
 * large — so the first line of a tail may be partial and is skipped.
 */

export const TAIL_BYTES = 256 * 1024;

/** One transcript line, loosely typed: only the fields we read. */
export interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
  [k: string]: unknown;
}

/** A content block of a message (text, tool_use, tool_result, …). */
export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
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

/** A message's content as blocks (a plain string becomes one text block). */
export function contentBlocks(entry: TranscriptEntry): ContentBlock[] {
  const c = entry.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (!Array.isArray(c)) return [];
  return c.filter((b): b is ContentBlock => !!b && typeof b === 'object');
}
