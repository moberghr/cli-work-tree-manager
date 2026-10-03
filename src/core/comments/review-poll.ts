/**
 * Pure helper for the `wd -c` polling loop in `commands/diff.ts`.
 *
 * Given the previous-tick set of "seen" comment ids and the current
 * snapshot, return:
 *   - new published comments to emit (in snapshot order)
 *   - deleted ids to emit
 *   - the next `seen` set to track going into the following tick
 *
 * The function MUTATES `seen` in place by adding new ids and removing
 * deleted ones. Callers can read `seen.size` after this returns to get
 * the running total — that's what's reported as `--- review done --- total`.
 *
 * Extracted from inline logic in `tryReviewViaWorkWeb` so it can be
 * tested without standing up a fake HTTP server or mocking process.exit.
 * The C-1 review finding (deleted ids never pruned, inflating the
 * reported total) lived here.
 */

import type { Comment } from './comment-types.js';

export interface SnapshotDiff {
  /** Published comments not already in `seen`, in snapshot order. */
  newComments: Comment[];
  /** Ids present in `seen` but missing from the current snapshot. */
  deleted: string[];
}

export function diffReviewSnapshot(
  snapshot: Comment[],
  seen: Set<string>,
): SnapshotDiff {
  const now = new Set(snapshot.map((c) => c.id));

  const deleted: string[] = [];
  for (const id of seen) {
    if (!now.has(id)) deleted.push(id);
  }
  for (const id of deleted) seen.delete(id);

  const newComments: Comment[] = [];
  for (const c of snapshot) {
    if (seen.has(c.id)) continue;
    if (c.status === 'draft') continue;
    newComments.push(c);
  }
  for (const c of snapshot) {
    if (c.status === 'published') seen.add(c.id);
  }

  return { newComments, deleted };
}
