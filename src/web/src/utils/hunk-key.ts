import type { Hunk } from '../api/client.js';

/**
 * Stable identity key for a diff hunk within a file, used to persist the
 * per-hunk "reviewed" checkbox across live-reload refreshes.
 *
 * The key is `${filePath}@${hash}` where the hash is derived from the hunk
 * BODY — the ordered (kind, content) of each line — and NOT from line
 * numbers. Line numbers (oldStart/newStart) shift whenever the user edits
 * an unrelated part of the file and chokidar pushes a fresh diff, which
 * would otherwise reset or misassign the checkmarks. The body is what the
 * reviewer actually checked off, so hashing it keeps the mark glued to the
 * same change.
 *
 * FNV-1a (32-bit) over a tab/newline-delimited rendering of the lines —
 * deterministic, dependency-free, and good enough for a per-file collision
 * domain (a handful of hunks). Same body in two files yields the same hash
 * but the filePath prefix keeps the overall key distinct.
 */
export function hunkContentKey(filePath: string, hunk: Hunk): string {
  let serialized = '';
  for (const line of hunk.lines) {
    serialized += line.kind + '\t' + line.content + '\n';
  }
  return `${filePath}@${fnv1a32(serialized)}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids float precision loss).
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}
