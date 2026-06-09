import type { Hunk } from '../api/client.js';

/**
 * Format a hunk's full unified-diff heading — `@@ -old,n +new,n @@` plus
 * git's trailing enclosing-function context. This is the same line git
 * prints; the diff viewer shows it (GitHub-style) on the hunk separator /
 * expander bar.
 */
export function hunkHeading(h: Hunk): string {
  const ctx = h.context ? ` ${h.context}` : '';
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${ctx}`;
}
