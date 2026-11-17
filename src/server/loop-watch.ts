import { monitorEventLoopDelay } from 'node:perf_hooks';
import { takeSlowestSync } from '../core/platform/sync-work.js';

/**
 * Is the server's event loop being blocked? Everything work web does — the
 * status a hook just recorded reaching the windows, a terminal's keystrokes,
 * notifications — waits behind synchronous work. This samples the loop's
 * delay and, when it stalled past `thresholdMs`, says how long and which
 * request was slowest meanwhile, so "the status didn't update" has an
 * answer instead of a guess.
 */

export interface Stall {
  /** The longest the loop waited, ms. */
  blockedMs: number;
  /** The slowest request in the window, if one was slow. */
  slowest: { what: string; ms: number } | null;
  /** The slowest synchronous command the server ran itself in the window (git, a process listing): what the loop waited on, most likely. */
  ran?: { what: string; ms: number } | null;
}

export function watchLoop(opts: {
  everyMs?: number;
  thresholdMs?: number;
  onStall: (s: Stall) => void;
  /** The slowest synchronous command since the last ask (sync-work.ts; tests pass their own). */
  ran?: () => { what: string; ms: number } | null;
}) {
  const ranSince = opts.ran ?? takeSlowestSync;
  const every = opts.everyMs ?? 10_000;
  const threshold = opts.thresholdMs ?? 1_000;
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let slowest: Stall['slowest'] = null;
  const timer = setInterval(() => {
    const blockedMs = Math.round(h.max / 1e6);
    h.reset();
    const s = slowest;
    slowest = null;
    // Taken every window, so one that ran in a quiet window is never blamed for a later stall.
    const ran = ranSince();
    if (blockedMs >= threshold) opts.onStall({ blockedMs, slowest: s, ran });
  }, every);
  timer.unref?.();
  return {
    /** A request finished: remember it if it was the slowest so far (and slow). */
    request(what: string, ms: number) {
      if (ms >= threshold / 2 && (!slowest || ms > slowest.ms)) slowest = { what, ms: Math.round(ms) };
    },
    stop() {
      clearInterval(timer);
      h.disable();
    },
  };
}

/** One line for the log and the Activity panel. */
export function describeStall(s: Stall): string {
  const secs = (s.blockedMs / 1000).toFixed(1);
  return `the server was blocked for ${secs} s (status updates, terminals and notifications waited)${s.slowest ? `; slowest request: ${s.slowest.what} (${(s.slowest.ms / 1000).toFixed(1)} s)` : ''}${s.ran ? `; it ran: ${s.ran.what} (${(s.ran.ms / 1000).toFixed(1)} s)` : ''}`;
}
