import { RUN_TIMED_OUT } from '../platform/command-runner.js';

/**
 * PURE — whether a host call that failed may still have been carried out. A review submit in your name must never go
 * out twice, so only a clear refusal counts as "nothing went out": the CLI isn't there, the run was refused before it
 * started, the host answered with a 4xx status (a validation error, not signed in, not allowed, not found, too many
 * requests), or the host's own words for a refusal (`refusal`, each adapter's). Anything else — a timeout, a 5xx, a
 * dropped connection, an error with no status — may have gone through: it's in doubt, for the user to look and say.
 */

/** A 4xx status as gh and az print it: `(HTTP 422)`, `HTTP 404`, `status code 400`, `(400)`, or its reason phrase. */
const CLIENT_ERROR =
  /\bHTTP[ /:]*4\d\d\b|\bstatus(?: code)?:? 4\d\d\b|\(4\d\d\)|\b(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Unprocessable Entity|Validation Failed|Too Many Requests)\b/i;

/** The run never started: work's own refusal (a batch file given special characters, a route value refused). */
const NOT_STARTED = /^refused: |: refused: /;

export function refusedClearly(code: number, stderr: string, refusal?: RegExp): boolean {
  if (code === 0 || code === RUN_TIMED_OUT) return false;
  if (code === 127) return true; // the CLI isn't installed: nothing was asked
  if (NOT_STARTED.test(stderr.trim())) return true;
  if (CLIENT_ERROR.test(stderr)) return true;
  return !!refusal && refusal.test(stderr);
}
