import { readJsonlTail, TAIL_BYTES } from '../../conversations/jsonl.js';
import type { TranscriptEntry } from './transcript-entry.js';

/**
 * Claude Code's transcripts (`~/.claude/projects/<dir>/<id>.jsonl`): the
 * JSON-lines reader (jsonl.ts), typed as Claude's entries.
 */

export { contentBlocks, type ContentBlock, type TranscriptEntry } from './transcript-entry.js';

/** The entries in the last `bytes` of a transcript, oldest first. [] when unreadable. */
export function readTranscriptTail(transcriptPath: string | undefined, bytes = TAIL_BYTES): TranscriptEntry[] {
  return readJsonlTail(transcriptPath, bytes) as TranscriptEntry[];
}
