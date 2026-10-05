import chalk from 'chalk';
import type { CleanupCandidate } from '../../core/api-types.js';
import type { CleanupResult } from '../../core/cleanup/cleanup.js';

/**
 * What prune / sync may remove: merged (or never committed to) and clean,
 * or its folder is gone. Squash-merge detection is a heuristic, so
 * unattended `sync` asks for it explicitly; `prune` (you pick) offers it.
 * With `dirtyToo`, merged worktrees with uncommitted changes as well.
 */
export function removable(candidates: CleanupCandidate[], opts: { includeSquash: boolean; dirtyToo?: boolean }): CleanupCandidate[] {
  return candidates.filter((c) => {
    if (c.verdict === 'gone') return true;
    const merged = c.repos.every((r) => !r.exists || r.merged !== null);
    if (!merged) return false;
    if (!opts.includeSquash && c.repos.some((r) => r.merged === 'squash')) return false;
    return c.verdict === 'merged' || (!!opts.dirtyToo && c.verdict === 'dirty');
  });
}

/** Per worktree: done, or left alone with the reason; then a total. */
export function printCleanupResults(chosen: CleanupCandidate[], results: CleanupResult[]): { ok: number; failed: number } {
  const byId = new Map(chosen.map((c) => [c.sessionId, c]));
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    const c = byId.get(r.sessionId);
    const name = c ? `${c.target}: ${c.branch}` : r.sessionId;
    if (r.ok) {
      ok++;
      console.log(chalk.green(`  ✓ ${name} — ${r.message}`));
    } else {
      failed++;
      console.log(chalk.yellow(`  ✗ ${name} — ${r.message}`));
    }
  }
  console.log('');
  console.log(chalk.green(`Removed ${ok} worktree(s).`) + (failed ? chalk.yellow(` Left ${failed} alone.`) : ''));
  return { ok, failed };
}
