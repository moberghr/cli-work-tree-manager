import { behindMain, updateFromMain, type Behind } from './behind-main.js';
import { logSwallowed } from '../platform/best-effort.js';
import type { WorkConfig } from '../platform/config.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { SessionStatus } from '../status/session-status.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionStacks, stackedOn } from './stack-sessions.js';
import { parentTipFor, retargetBlocker, retargetIsClean, retargetOntoMain } from './stack-retarget.js';
import { setSessionBase } from '../sessions/history.js';
import type { RunHandle } from '../platform/activity.js';

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

export type StackSyncResult = { updated: true; commits: number; how: string; told: boolean } | { updated: false; why: string };

const busyWhy = (state: SessionStatus['state'] | null) =>
  state === 'working' ? 'its Claude is working' : state === 'needs_input' ? 'its Claude is waiting for your answer' : null;

export async function syncStackChild(child: WorktreeSession, parentBranch: string, deps: StackSyncDeps): Promise<StackSyncResult> {
  const run = deps.run ?? defaultRunner;
  const busy = busyWhy(deps.shownState(child));
  if (busy) return { updated: false, why: busy };
  const behind: Array<{ path: string; b: Behind }> = [];
  for (const p of child.paths) {
    const b = await behindMain(p, run, parentBranch);
    if (b && b.commits > 0) behind.push({ path: p, b });
  }
  if (behind.length === 0) return { updated: false, why: `already on top of ${parentBranch}` };
  if (behind.some((x) => x.b.conflicts)) return { updated: false, why: `bringing in ${parentBranch} would conflict: left for you (Update from ${parentBranch})` };
  // Where each repo is now, to put a group back if a later repo fails.
  const heads = new Map<string, string>();
  for (const { path: p } of behind) {
    const st = await run('git', ['-C', p, 'status', '--porcelain'], p);
    if (st.code !== 0 || st.stdout.trim()) return { updated: false, why: 'it has uncommitted changes' };
    const head = await run('git', ['-C', p, 'rev-parse', 'HEAD'], p);
    if (head.code !== 0) return { updated: false, why: `${p}: ${head.stderr.trim() || 'no HEAD'}` };
    heads.set(p, head.stdout.trim());
  }
  let commits = 0;
  const hows = new Set<string>();
  const done: string[] = [];
  for (const { path: p } of behind) {
    // A turn may have started while git looked: ask again right before each change.
    const nowBusy = busyWhy(deps.shownState(child));
    const r = nowBusy ? null : await updateFromMain(p, run, parentBranch);
    if (!r || !r.ok) {
      // All or nothing: put back the repos already brought in (they were clean, so nothing of anyone's is lost).
      for (const q of done) await run('git', ['-C', q, 'reset', '--hard', '--quiet', heads.get(q)!], q);
      return { updated: false, why: nowBusy ?? `${r!.repo}: ${(r as { reason: string }).reason}${done.length ? ' (the others were put back)' : ''}` };
    }
    done.push(p);
    commits = Math.max(commits, r.commits);
    if (r.how !== 'nothing') hows.add(r.how === 'rebase' ? 'rebased on it' : 'merged it in');
  }
  const how = [...hows].join(' / ');
  let told = true;
  await deps
    .tell(
      child,
      `Your branch was brought up to date with ${parentBranch} — the session this one is stacked on — ${commits} new commit${commits === 1 ? '' : 's'} (${how}). Files may have changed since you last read them; look again before editing them.`,
    )
    .catch((err) => {
      told = false;
      logSwallowed(`telling ${child.branch} it was updated from ${parentBranch}`, err);
    });
  return { updated: true, commits, how, told };
}

/**
 * After its own turn: a session whose parent merged (archived) moves onto
 * main — by the same rules (idle, clean, git says it goes cleanly), all
 * repos or none, its Claude told. Null when it isn't such a session.
 */
export async function retargetIfMerged(
  child: WorktreeSession,
  parent: Parameters<typeof parentTipFor>[1],
  config: WorkConfig | null,
  deps: StackSyncDeps,
): Promise<StackSyncResult> {
  const run = deps.run ?? defaultRunner;
  const busy = busyWhy(deps.shownState(child));
  if (busy) return { updated: false, why: busy };
  const tips = new Map<string, string | null>();
  for (const p of child.paths) tips.set(p, await parentTipFor(p, parent, config, run));
  for (const p of child.paths) {
    const tip = tips.get(p);
    if (!tip) return { updated: false, why: `${parent.branch} merged, but its tip is unknown here: Move onto main by hand` };
    const blocker = await retargetBlocker(p, { branch: parent.branch, tip }, run);
    if (blocker?.handOff) {
      // Git alone can't tell its own commits from the parent's old ones: its Claude can (once per parent tip).
      const key = `${sessionIdFor(child)}:${tip}`;
      if (handedOff.has(key)) return { updated: false, why: `${parent.branch} was rewritten before it merged; its Claude was already asked to move it onto main` };
      handedOff.add(key);
      await deps.tell(child, ontoMainPrompt(parent.branch)).catch((err) => logSwallowed(`asking ${child.branch} to move onto main`, err));
      return { updated: false, why: `${parent.branch} was rewritten before it merged: its Claude was asked to move this branch onto main` };
    }
    if (!(await retargetIsClean(p, { branch: parent.branch, tip }, run))) {
      return { updated: false, why: `${parent.branch} merged; moving onto main isn't sure to go cleanly (a conflict, uncommitted changes, a rewritten parent, or an old git): left for you` };
    }
  }
  // Asked again right before each repo is changed (a turn may have started while git looked).
  const r = await retargetOntoMain(child, async (p) => ({ branch: parent.branch, tip: tips.get(p) ?? null }), run, () => busyWhy(deps.shownState(child)));
  if (!r.ok) return { updated: false, why: r.results.filter((x) => !x.ok).map((x) => `${x.repo}: ${(x as { reason: string }).reason}`).pop() ?? 'failed' };
  await setSessionBase(child.target, child.branch, r.bases ?? {});
  const main = [...new Set(Object.values(r.bases ?? {}))].join(' / ') || 'main';
  let told = true;
  await deps
    .tell(child, `${parent.branch} — the branch this one was stacked on — has merged, so this branch was moved onto ${main} (only its own commits kept on top). Files may have changed since you last read them; look again before editing them.`)
    .catch((err) => {
      told = false;
      logSwallowed(`telling ${child.branch} it moved onto main`, err);
    });
  return { updated: true, commits: r.results.reduce((n, x) => n + (x.ok ? x.commits : 0), 0), how: `moved onto ${main}`, told };
}

/** Rewritten parents already handed to a child's Claude (child id : parent tip), so it is asked once. */
const handedOff = new Set<string>();

/** What a child's Claude is asked when git alone can't move it onto main. */
export function ontoMainPrompt(parentBranch: string): string {
  return `${parentBranch} — the branch this one was stacked on — has merged into main, but it was rebased or amended before it merged, so git can't tell this branch's own commits from ${parentBranch}'s old ones. Move this branch onto origin/main keeping only this branch's own work (git rebase --onto origin/main <the commit this branch started from>, dropping ${parentBranch}'s commits; if this branch was already pushed, merge origin/main in instead). Run the tests and commit. If it isn't clear which commits are this branch's, start a line with DECISION NEEDED: and ask.`;
}

/**
 * A session was archived: those stacked on it that are now stacked on a
 * merged session move onto main, by the same rules as after their own turn
 * (idle, clean, goes cleanly; a rewritten parent goes to their Claude).
 */
export async function retargetChildrenOf(parentId: string, deps: Omit<AfterTurnDeps, 'busy'> & { busy: Set<string> }): Promise<number> {
  const history = deps.history();
  const config = deps.config();
  if (config?.stacks?.autoUpdate === false) return 0;
  const stacks = sessionStacks(history, config);
  const children = history.filter((s) => stacks.mergedParentOf.get(sessionIdFor(s))?.id === parentId);
  if (children.length === 0) return 0;
  const run = deps.startRun();
  let moved = 0;
  for (const child of children) {
    const id = sessionIdFor(child);
    if (deps.busy.has(id)) continue;
    deps.busy.add(id);
    try {
      const r = await retargetIfMerged(child, stacks.mergedParentOf.get(id)!, config, deps);
      if (r.updated) {
        moved++;
        deps.invalidate(id);
        run.note(`${child.branch}: ${r.how} (its parent merged and was archived)${r.told ? '; its Claude was told' : ' — telling its Claude failed'}`, { sessionId: id, ...(r.told ? {} : { level: 'warn' as const }) });
      } else run.note(`${child.branch}: left as it is — ${r.why}`, { sessionId: id });
    } catch (err) {
      run.note(`${child.branch}: ${(err as Error).message}`, { sessionId: id, level: 'warn' });
    } finally {
      deps.busy.delete(id);
    }
  }
  run.done(moved ? `${moved} moved onto main` : 'none could move by itself');
  return moved;
}

export interface AfterTurnDeps extends StackSyncDeps {
  history: () => WorktreeSession[];
  config: () => WorkConfig | null;
  /** Its turn may have committed: what the chips say about these sessions is stale. */
  invalidate: (sessionId: string) => void;
  /** An Activity run for the decisions (one per sweep that has anything to look at). */
  startRun: () => Pick<RunHandle, 'note' | 'done'>;
  /** Sessions being brought up to date right now (shared across calls: one at a time each). */
  busy: Set<string>;
}

/**
 * After a session's turn ended: the sessions stacked on it — and itself, when
 * it is stacked and its parent moved while it worked — each brought up to
 * date if it can be (syncStackChild). Returns how many were.
 */
export async function syncStacksAfterTurn(sessionId: string, deps: AfterTurnDeps): Promise<number> {
  const history = deps.history();
  const config = deps.config();
  const stacks = sessionStacks(history, config);
  const self = history.find((s) => sessionIdFor(s) === sessionId);
  const merged = self ? stacks.mergedParentOf.get(sessionId) : undefined;
  const candidates = [...(self && stacks.parentOf.has(sessionId) ? [self] : []), ...stackedOn(sessionId, stacks, history)];
  if (candidates.length === 0 && !merged) return 0;
  for (const c of candidates) deps.invalidate(sessionIdFor(c));
  if (config?.stacks?.autoUpdate === false) return 0;
  const run = deps.startRun();
  let updated = 0;
  if (self && merged && !deps.busy.has(sessionId)) {
    deps.busy.add(sessionId);
    try {
      const r = await retargetIfMerged(self, merged, config, deps);
      if (r.updated) {
        updated++;
        deps.invalidate(sessionId);
        run.note(`${self.branch}: ${r.how} (${merged.branch} merged)${r.told ? '; its Claude was told' : " — telling its Claude failed"}`, { sessionId, ...(r.told ? {} : { level: 'warn' as const }) });
      } else run.note(`${self.branch}: left as it is — ${r.why}`, { sessionId });
    } catch (err) {
      run.note(`${self.branch}: ${(err as Error).message}`, { sessionId, level: 'warn' });
    } finally {
      deps.busy.delete(sessionId);
    }
  }
  for (const child of candidates) {
    const childId = sessionIdFor(child);
    const parent = stacks.parentOf.get(childId);
    if (!parent || deps.busy.has(childId)) continue;
    deps.busy.add(childId);
    try {
      const r = await syncStackChild(child, parent.branch, deps);
      if (r.updated) {
        updated++;
        deps.invalidate(childId);
        run.note(
          `${child.branch}: ${r.commits} commit${r.commits === 1 ? '' : 's'} from ${parent.branch} (${r.how})${r.told ? '; its Claude was told' : "; telling its Claude failed — it doesn't know yet"}`,
          { sessionId: childId, ...(r.told ? {} : { level: 'warn' as const }) },
        );
      } else {
        run.note(`${child.branch}: left as it is — ${r.why}`, { sessionId: childId });
      }
    } catch (err) {
      run.note(`${child.branch}: ${(err as Error).message}`, { sessionId: childId, level: 'warn' });
    } finally {
      deps.busy.delete(childId);
    }
  }
  run.done(updated ? `${updated} brought up to date` : 'nothing to bring in');
  return updated;
}
