/**
 * Shared selection logic for the fleet commands (`work run`, `work broadcast`).
 * Pure helpers so command files stay thin and the filtering is unit-testable.
 *
 * Direction: core does NOT import from commands. Commands import these.
 */

import type { WorktreeSession } from './history.js';

export interface FleetFilter {
  /** Restrict to sessions whose target matches this alias/group name. */
  target?: string;
  /** With `target`, further restrict to a single branch. */
  branch?: string;
}

/**
 * Select the sessions a fleet command should act on.
 *
 * - No filter → every session.
 * - `target` only → all sessions for that target.
 * - `target` + `branch` → the single matching session (if any).
 *
 * `branch` without `target` is ignored for selection but the caller is
 * expected to reject that combination up front (it's ambiguous).
 */
export function selectSessions(
  sessions: WorktreeSession[],
  filter: FleetFilter,
): WorktreeSession[] {
  return sessions.filter((s) => {
    if (filter.target && s.target !== filter.target) return false;
    if (filter.branch && s.branch !== filter.branch) return false;
    return true;
  });
}

export interface RunUnit {
  session: WorktreeSession;
  /** A single worktree directory to run the command in. */
  path: string;
}

/**
 * Flatten selected sessions into one unit of work per worktree path. Group
 * sessions contribute one unit per path. Order is stable (session order,
 * then path order) so sequential runs are deterministic.
 */
export function expandRunUnits(sessions: WorktreeSession[]): RunUnit[] {
  const units: RunUnit[] = [];
  for (const session of sessions) {
    for (const p of session.paths) {
      units.push({ session, path: p });
    }
  }
  return units;
}

export interface RunResult extends RunUnit {
  /** Exit code; null when the process was killed by a signal. */
  code: number | null;
  ok: boolean;
}

/** True when any unit failed (non-zero / signalled). */
export function anyFailed(results: RunResult[]): boolean {
  return results.some((r) => !r.ok);
}
