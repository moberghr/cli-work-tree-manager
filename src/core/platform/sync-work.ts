/**
 * The slowest synchronous command this process ran lately: what a blocked event loop was most likely waiting on.
 * work web's stall report (loop-watch.ts) said how long the loop was blocked and which request was slowest, but most
 * stalls had no slow request (reported: 105 of a day's 126) — a timer's job ran git or listed processes
 * synchronously, and nothing named it. The sync spawn wrapper and the process listing note what they ran here; the
 * stall report takes it. Imports nothing: every `work hook` loads the spawn wrapper.
 */

/** Shorter than this isn't worth naming. */
const NOTE_MS = 250;
const MAX_WHAT = 160;

let slowest: { what: string; ms: number } | null = null;

/** A synchronous piece of work finished: remembered when it's the slowest since the last take. */
export function noteSyncWork(what: string, ms: number): void {
  if (ms >= NOTE_MS && (!slowest || ms > slowest.ms)) slowest = { what: what.slice(0, MAX_WHAT), ms: Math.round(ms) };
}

/** The slowest since the last take (null: nothing slow ran), forgotten once taken. */
export function takeSlowestSync(): { what: string; ms: number } | null {
  const s = slowest;
  slowest = null;
  return s;
}

/** Run `fn`, noting how long it took under `what` (asked for only when it was slow enough to keep). */
export function timedSync<T>(what: () => string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms >= NOTE_MS) noteSyncWork(what(), ms);
  }
}

/** A command as the report names it: the program and its first arguments ("git worktree remove C:\wt\x"), never all of them. */
export function commandName(args: readonly unknown[]): string {
  const [program, argv] = args;
  const name = String(program ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat)$/i, '');
  const first = Array.isArray(argv) ? argv.filter((a): a is string => typeof a === 'string').slice(0, 3) : [];
  return [name, ...first].join(' ');
}
