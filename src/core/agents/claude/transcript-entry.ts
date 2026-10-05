/**
 * The shape of Claude Code transcript lines, and reading their content —
 * pure, so the demo and the digest can use it without the file reader
 * (transcript.ts).
 */

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

/** A message's content as blocks (a plain string becomes one text block). */
export function contentBlocks(entry: TranscriptEntry): ContentBlock[] {
  const c = entry.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (!Array.isArray(c)) return [];
  return c.filter((b): b is ContentBlock => !!b && typeof b === 'object');
}
