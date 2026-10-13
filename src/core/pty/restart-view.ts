/**
 * How a restart of agents is said (agent-restart.ts), the same in the dashboard,
 * the Activity panel and `work restart`. Pure: the SPA imports it.
 */

/** What a session waiting for its turn is told it will do. */
export const LATER_TEXT = 'restarts when its turn ends';

/** "2 sessions restarted · 1 restarts when its turn ends · 1 couldn't: <why>." */
export function restartCountsText(c: { restarted: number; later: number; failed: number; firstError?: string }): string {
  const parts: string[] = [];
  if (c.restarted) parts.push(`${c.restarted} session${c.restarted === 1 ? '' : 's'} restarted`);
  if (c.later) parts.push(`${c.later} ${c.later === 1 ? LATER_TEXT : 'restart when their turns end'}`);
  if (c.failed) parts.push(`${c.failed} couldn't${c.firstError ? `: ${c.firstError}` : ''}`);
  return parts.length ? `${parts.join(' · ')}.` : 'Nothing to restart.';
}
