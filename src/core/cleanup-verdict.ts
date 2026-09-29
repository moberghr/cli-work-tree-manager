import type { CleanupAction, CleanupRepo, CleanupVerdict } from './api-types.js';

/**
 * What to do with a worktree, given its git facts — pure, so the demo and
 * the real scan (cleanup.ts) decide the same way.
 */

/** Used this recently: never offered for cleanup (unless its folder is gone). */
export const CLEANUP_MIN_IDLE_MS = 24 * 3_600_000;
/** Quiet this long with work of its own: offered for archiving. */
export const CLEANUP_ARCHIVE_AFTER_MS = 7 * 24 * 3_600_000;

export interface VerdictInput {
  repos: CleanupRepo[];
  lastActiveMs: number;
  archived: boolean;
}

/** What to do with a session, and the one line that says why. */
export function cleanupVerdict(i: VerdictInput, now: number = Date.now()): { verdict: CleanupVerdict; suggested: CleanupAction | null; reason: string } {
  const idle = now - i.lastActiveMs;
  if (i.repos.length === 0 || i.repos.every((r) => !r.exists)) {
    return { verdict: 'gone', suggested: 'forget', reason: 'Its folder is gone: only the session entry is left' };
  }
  if (i.repos.some((r) => r.baseCheckout)) {
    return { verdict: 'keep', suggested: null, reason: 'The repo itself (base checkout), not a worktree' };
  }
  if (idle < CLEANUP_MIN_IDLE_MS) return { verdict: 'keep', suggested: null, reason: 'Used in the last day' };
  const present = i.repos.filter((r) => r.exists);
  if (present.some((r) => !r.readable)) return { verdict: 'keep', suggested: null, reason: "git can't read it; check it by hand" };
  if (present.some((r) => r.base === null || r.ahead === null)) {
    return { verdict: 'keep', suggested: null, reason: 'No origin default branch to compare with' };
  }
  const dirty = present.reduce((n, r) => n + (r.dirty ?? 0), 0);
  const unmerged = present.filter((r) => r.merged === null);
  const oldEnough = idle >= CLEANUP_ARCHIVE_AFTER_MS;
  const archive = oldEnough && !i.archived ? ('archive' as const) : null;
  if (dirty > 0) {
    return {
      verdict: 'dirty',
      suggested: archive,
      reason: `${dirty} uncommitted file${dirty === 1 ? '' : 's'}${unmerged.length ? ', and commits not in the main branch' : ''}`,
    };
  }
  if (unmerged.length > 0) {
    const commits = unmerged.reduce((n, r) => n + (r.ahead ?? 0), 0);
    return { verdict: 'work', suggested: archive, reason: `${commits} commit${commits === 1 ? '' : 's'} not in ${unmerged[0].base}` };
  }
  const squash = present.some((r) => r.merged === 'squash');
  return {
    verdict: 'merged',
    suggested: 'delete',
    reason: squash
      ? `Squash-merged into ${present[0].base}, nothing uncommitted`
      : `Nothing here that isn't in ${present[0].base}, nothing uncommitted`,
  };
}
