import { behindMain, updateFromMain, type Behind } from './behind-main.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import type { SessionStatus } from './session-status.js';
import type { WorktreeSession } from './session-types.js';

/**
 * Keep a stacked session (stack.ts) on top of its parent: when the parent's
 * branch has new commits, bring them in — by the same rules as Update from
 * (rebase a branch never pushed, merge into a pushed one) — but only when
 * nothing can go wrong under anyone: its Claude is neither working nor
 * waiting on you, nothing is uncommitted, and git says it merges cleanly.
 * Otherwise it is left alone, and the header's "behind" chip offers it.
 * Its Claude is told, since files may have changed since it read them.
 */

export interface StackSyncDeps {
  run?: CommandRunner;
  /** The status the dashboard shows (turn-activity.ts shownState). */
  shownState: (s: WorktreeSession) => SessionStatus['state'] | null;
  /** Post a note for the session's Claude (delivered like a review comment). */
  tell: (s: WorktreeSession, body: string) => Promise<void>;
}

export type StackSyncResult = { updated: true; commits: number; how: string } | { updated: false; why: string };

export async function syncStackChild(child: WorktreeSession, parentBranch: string, deps: StackSyncDeps): Promise<StackSyncResult> {
  const run = deps.run ?? defaultRunner;
  const state = deps.shownState(child);
  if (state === 'working') return { updated: false, why: 'its Claude is working' };
  if (state === 'needs_input') return { updated: false, why: 'its Claude is waiting for your answer' };
  const behind: Array<{ path: string; b: Behind }> = [];
  for (const p of child.paths) {
    const b = await behindMain(p, run, parentBranch);
    if (b && b.commits > 0) behind.push({ path: p, b });
  }
  if (behind.length === 0) return { updated: false, why: `already on top of ${parentBranch}` };
  if (behind.some((x) => x.b.conflicts)) return { updated: false, why: `bringing in ${parentBranch} would conflict: left for you (Update from ${parentBranch})` };
  // All or nothing: a dirty repo of a group would leave it half updated.
  for (const { path: p } of behind) {
    const st = await run('git', ['-C', p, 'status', '--porcelain'], p);
    if (st.code !== 0 || st.stdout.trim()) return { updated: false, why: 'it has uncommitted changes' };
  }
  let commits = 0;
  const hows = new Set<string>();
  for (const { path: p } of behind) {
    const r = await updateFromMain(p, run, parentBranch);
    if (!r.ok) return { updated: false, why: `${r.repo}: ${r.reason}` };
    commits = Math.max(commits, r.commits);
    if (r.how !== 'nothing') hows.add(r.how === 'rebase' ? 'rebased on it' : 'merged it in');
  }
  const how = [...hows].join(' / ');
  await deps.tell(
    child,
    `Your branch was brought up to date with ${parentBranch} — the session this one is stacked on — ${commits} new commit${commits === 1 ? '' : 's'} (${how}). Files may have changed since you last read them; look again before editing them.`,
  ).catch(() => {});
  return { updated: true, commits, how };
}
