import type {
  CheckpointEntry,
  CheckpointRangeEnd,
} from '../api/client.js';

export interface CheckpointRange {
  from: number;
  to: CheckpointRangeEnd;
}

export type RangeDecision =
  | { kind: 'legacy' } // No range — caller fetches HEAD → working
  | { kind: 'range'; range: CheckpointRange };

/**
 * Decide the default / next checkpoint range given:
 *   - the current list of checkpoint entries (from the server)
 *   - whether the user has manually picked a range this session
 *   - their previous range (if any)
 *
 * Pulled out of `ReviewApp` so the decision rule is testable in
 * isolation and the React component just renders.
 *
 * Rules:
 *   1. `entries.length <= 1`: legacy mode. Initial alone is identical
 *      to the live working tree (it was captured a moment ago, same
 *      state), so a range against it is empty — confusing on first
 *      open. The legacy HEAD → working diff is what users expect.
 *   2. No user pick: pin `from` to the first entry (Initial),
 *      `to: 'working'`. The strip is a baseline-comparison tool;
 *      auto-advancing `from` to the newest checkpoint would collapse
 *      to "since the last save" each autosave, instantly losing
 *      the baseline.
 *   3. User pick: keep it unless either endpoint no longer exists
 *      (scope torn down + re-registered, manifest rotated). In that
 *      case fall back to the default and clear the user-picked flag.
 */
export function decideRange(
  entries: CheckpointEntry[],
  userPicked: boolean,
  prev: CheckpointRange | null,
): RangeDecision & {
  /** Set when the function decided to override a stale user pick.
   *  Callers use this to clear their `userPickedRef`. */
  resetUserPicked?: boolean;
} {
  if (entries.length <= 1) {
    return { kind: 'legacy' };
  }
  const firstId = entries[0].id;
  if (!userPicked || !prev) {
    return { kind: 'range', range: { from: firstId, to: 'working' } };
  }
  const fromExists = entries.some((e) => e.id === prev.from);
  const toExists =
    prev.to === 'working' || entries.some((e) => e.id === prev.to);
  if (!fromExists || !toExists) {
    return {
      kind: 'range',
      range: { from: firstId, to: 'working' },
      resetUserPicked: true,
    };
  }
  return { kind: 'range', range: prev };
}
