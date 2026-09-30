import type { PtyInfo } from './pty-host-protocol.js';

/**
 * Which session Claudes to put to sleep: stop them in the PTY host so they
 * stop holding memory (a few hundred MB each; a dozen once ran the machine
 * out). Opening the session later starts it again with its conversation
 * (--continue), as after a restart. Pure: the caller lists and stops.
 *
 * Asleep only when ALL of these hold:
 *  - nothing is attached: no dashboard Terminal tab, no `work attach`
 *    (a host from before `clients` was reported: never);
 *  - it has printed nothing for `afterMs` — an idle Claude at its prompt
 *    prints nothing, a working one keeps redrawing its spinner;
 *  - its status isn't working or waiting for an answer;
 *  - it isn't the dashboard assistant (Ctrl+K), which is meant to stay.
 */
export const DEFAULT_SLEEP_AFTER_MINUTES = 240;

export function sleepCandidates(
  ptys: readonly PtyInfo[],
  now: number,
  afterMs: number,
  busy: (id: string) => boolean,
  keep: ReadonlySet<string> = new Set(['assistant']),
): string[] {
  if (afterMs <= 0) return [];
  return ptys
    .filter((p) => {
      if (p.exited || keep.has(p.id)) return false;
      if (p.clients === undefined || p.clients > 0) return false;
      const last = p.lastOutputAt ? Date.parse(p.lastOutputAt) : NaN;
      if (!Number.isFinite(last) || now - last < afterMs) return false;
      return !busy(p.id);
    })
    .map((p) => p.id);
}
