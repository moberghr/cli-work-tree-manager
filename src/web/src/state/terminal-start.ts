/**
 * A Terminal tab whose start failed — the PTY host didn't answer, or was
 * replaced while it started the session — tries again by itself, a little
 * later each time, then waits for a click. Pure.
 */

/** Seconds before each try again after a failed start; none after the last (a click starts it again). */
export const START_RETRY_SECONDS = [3, 10, 30, 60];

/** The wait before try number `attempt` (0 = the first try again), or null: no more on its own. */
export function startRetryDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < START_RETRY_SECONDS.length ? START_RETRY_SECONDS[attempt] * 1000 : null;
}

/** What a failed start says: the server's reason when it gave one, else that the connection closed. */
export function startFailure(reason: string | null): string {
  return reason?.trim() ? reason.trim() : 'the connection closed before it started';
}
