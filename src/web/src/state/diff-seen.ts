import type { CheckpointEntry } from '../api/client.js';
import type { ParsedFile } from '../../../core/diff/diff-parse.js';

/** The newest turn (checkpoint id) a session has; null before its first. Pure. */
export function newestCheckpoint(checkpoints: Pick<CheckpointEntry, 'id'>[]): number | null {
  return checkpoints.length ? Math.max(...checkpoints.map((c) => c.id)) : null;
}

/**
 * A file's change in a few characters: its +/− counts and a hash of its
 * hunks. A Viewed tick keeps it, and is shown only while the file's change
 * still has it — a file Claude touched again is up for review again. Pure.
 */
export function fileSignature(f: Pick<ParsedFile, 'added' | 'deleted' | 'hunks'>): string {
  let h = 5381;
  for (const hunk of f.hunks) {
    for (const l of hunk.lines) {
      const t = `${l.kind}${l.content}`;
      for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    }
  }
  return `${f.added}.${f.deleted}.${(h >>> 0).toString(36)}`;
}
