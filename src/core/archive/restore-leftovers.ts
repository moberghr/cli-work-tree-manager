import { isLeftover } from '../worktree/leftover.js';
import { describeProcess, findHolders, normDir, stopRunningFrom, type Holders } from '../platform/running-from.js';

/**
 * Before a Restore makes a worktree again over what git left of it (a folder
 * it removed only in part, leftover.ts): that folder has to be moved out of
 * the way, and can't be while something runs from it — a dev server its
 * Claude left running. One place for both front-ends: the dashboard's
 * Restore (which asks "Stop it and restore?") and `work tree` (which says
 * what to stop).
 */

export interface LeftoverIo {
  /** What runs from or names the folders (running-from.ts). */
  holders?: (dirs: string[]) => Promise<Holders>;
  /** Stop what runs from them, saying what. */
  stop?: (dirs: string[]) => Promise<string[]>;
}

/** The session's folders git removed only in part. */
export function leftoversOf(paths: string[]): string[] {
  return paths.filter((p) => isLeftover(p));
}

const names = (procs: Holders['stoppable'], dirs: string[]) =>
  procs.map((p) =>
    describeProcess(
      p,
      dirs.map((d) => normDir(d)),
    ),
  );

/** What runs from the leftovers now ("node …\vite\bin\vite.js --mode demo (PID 35464)"): none to wait for, []. */
export async function runningFromLeftovers(leftovers: string[], io: LeftoverIo = {}): Promise<string[]> {
  if (leftovers.length === 0) return [];
  const h = await (io.holders ?? ((d: string[]) => findHolders(d)))(leftovers).catch(() => null);
  return h ? names(h.stoppable, leftovers) : [];
}

/** Stop what runs from the leftovers (asked for), saying what. */
export async function freeLeftovers(leftovers: string[], io: LeftoverIo = {}): Promise<string[]> {
  if (leftovers.length === 0) return [];
  return (io.stop ?? ((d: string[]) => stopRunningFrom(d)))(leftovers).catch(() => []);
}

/** Everything that has the leftovers open — what runs from them and what only names them (an editor) — for a failure's message. */
export async function openInLeftovers(leftovers: string[], io: LeftoverIo = {}): Promise<string[]> {
  if (leftovers.length === 0) return [];
  const h = await (io.holders ?? ((d: string[]) => findHolders(d)))(leftovers).catch(() => null);
  return h ? [...names(h.stoppable, leftovers), ...names(h.others, leftovers)] : [];
}
