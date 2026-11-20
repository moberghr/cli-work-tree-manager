import type { WorktreeSession } from '../sessions/session-types.js';
import { report } from '../platform/report.js';
import { childText, runWorkChild, type ChildRun } from './setup-child.js';

/**
 * Removing a worktree runs git synchronously (`git worktree remove` deletes every file, and waits on any the antivirus
 * or an editor holds): done inside work web on Archive, it held up every request — the terminals' tickets, the status
 * hooks — for as long as the delete took (reported: 24 s, the PTY host read as not answering). So work web runs it as
 * `work remove … --worktree-only` in a child process, as it does creation (setup-child.ts). The CLI removes in
 * process, as before.
 */

/** The line `work remove --worktree-only` ends with: whether every folder went (the parent reads only this). */
export const WORKTREE_REMOVED = 'work-worktree-removed ';

/** What the child said of the removal; null when it never got to say (it crashed, or was killed). Pure. */
export function removedOf(stdout: string): boolean | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(WORKTREE_REMOVED));
  if (!line) return null;
  const v = line.slice(WORKTREE_REMOVED.length).trim();
  return v === 'true' ? true : v === 'false' ? false : null;
}

/** The child's command line: the session's folders are found from its row, never passed. `--` keeps a name from reading as a flag. */
export function removeChildArgs(s: Pick<WorktreeSession, 'target' | 'branch'>): string[] {
  return ['remove', '--worktree-only', '--', s.target, s.branch];
}

export type RemoveWorktree = (s: WorktreeSession) => Promise<boolean>;

/**
 * Remove a session's worktree in a child process: true when every folder went, false when one stayed (in use,
 * unreadable) — as `teardownWorktree` answers. A child that never answered (crashed, timed out) counts as not removed,
 * reported with what it printed: the archive then keeps the worktree.
 */
export function removeWorktreeInChild(
  workBin: () => string,
  opts: { timeoutMs?: number; execArgv?: string[]; run?: (bin: string, args: string[]) => Promise<ChildRun> } = {},
): RemoveWorktree {
  return async (s) => {
    const run = opts.run ?? ((bin, args) => runWorkChild(bin, args, opts));
    const r = await run(workBin(), removeChildArgs(s));
    const removed = removedOf(r.stdout);
    if (removed !== null) return removed;
    const why =
      r.spawnError ?? (r.timedOut ? 'it took too long and was stopped' : childText(r.stderr || r.stdout) || `it ended with code ${r.code}`);
    // Not removed, as far as anyone can tell: the archive keeps the worktree, and this says why.
    report('warn', `Couldn't remove the worktree of ${s.target} ${s.branch}: ${why}`);
    return false;
  };
}
