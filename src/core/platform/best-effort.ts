import { debugLog } from './logger.js';

/**
 * "Best effort" without flying blind. Plenty of work's side paths must never
 * break the main one — a Claude hook must not block the turn, a failed
 * status write must not fail a request — so errors are swallowed. But a
 * silent `catch {}` makes those failures invisible when someone asks "why
 * didn't my session show up / get restored / get a status?". These helpers
 * swallow AND record to ~/.work/debug.log (rotated), labelled.
 *
 * Use for failures that would explain a symptom. Plain noise — unlinking a
 * file that's already gone, writing to a socket that just closed — can stay
 * a bare catch.
 */

export function logSwallowed(label: string, err: unknown): void {
  const e = err as { code?: string; message?: string } | null;
  const detail = e?.message ?? String(err);
  debugLog('WARN', `[best-effort] ${label}: ${e?.code ? `${e.code} ` : ''}${detail}`);
}

/** Run `fn`; on throw, log it and return `fallback`. */
export function bestEffort<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (err) {
    logSwallowed(label, err);
    return fallback;
  }
}

/** Async variant; also catches rejections. */
export async function bestEffortAsync<T>(label: string, fn: () => Promise<T>, fallback?: T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logSwallowed(label, err);
    return fallback;
  }
}

/** For promise chains: `.catch(swallow('label'))`. */
export function swallow(label: string): (err: unknown) => undefined {
  return (err) => {
    logSwallowed(label, err);
    return undefined;
  };
}
