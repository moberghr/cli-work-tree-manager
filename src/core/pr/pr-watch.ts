import type { WorktreeSession } from '../sessions/session-types.js';
import type { SessionCi, ShipPreflight, OpenReviewThread } from '../api-types.js';
import { DECISION_MARKER } from '../status/attention.js';
import {
  newFeedback,
  openThreadCount,
  reviewMessage,
  type FeedbackItem,
  type ReviewFeedback,
  type SeenStore,
  openThreadsOf,
} from './pr-review.js';
import type { ActivityLog, RunHandle, ScheduleHandle } from '../platform/activity.js';
import { DEFAULT_TRUSTED_BOTS, subAgentHint } from './pr-review.js';

/** What waking a session's Claude did: started it; it was already running (it has the note);
 *  waking is off; or it couldn't (no PTY host, no worktree). */
export type WakeResult = 'started' | 'running' | 'off' | 'failed';

/**
 * Background PR watch for `work web` (full mode): what GitHub knows about
 * each recent session's PRs, acted on so you don't have to poll it.
 *
 *   - CI state per session, for the session header's CI strip.
 *   - CI newly failing on a PR → tell THAT session's Claude (it has the
 *     context) to fix it, asking you if it needs a decision. Once per PR
 *     head commit, so a push that fails again is reported again.
 *   - New review feedback on an open PR (unresolved threads, reviews,
 *     comments by others — see pr-review.ts) → hand it to that Claude to
 *     address, or to ask you if it needs a decision.
 *   - Every repo done and something merged → archive the session (the
 *     same rule as Ship's merge; a follow-up commit keeps it open).
 *
 * No agent does the watching: this is plain polling of `gh` through the
 * Ship preflight, a few sessions at a time. Both actions are on by
 * default and can be turned off in config (`prWatch`).
 *
 * All I/O is injected, so the policy is testable without git or gh.
 */

export interface PrWatchDeps {
  /** Sessions worth checking (recent, not archived). */
  sessions: () => Array<{ id: string; session: WorktreeSession }>;
  preflight: (session: WorktreeSession) => Promise<ShipPreflight>;
  /** Archive merged work (archiveSession `merged`); resolves to what it kept that was waiting in it ("2 reply drafts"), if anything. */
  archive: (id: string) => Promise<string | void>;
  /** Leave the session's Claude a (published) review note. */
  tell: (id: string, body: string) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  options: () => { autoArchive: boolean; fixCi: boolean; reviewComments: boolean; trustedBots?: string[] };
  /** Threads just handed to a session's Claude, for the reply drafts (pr-replies.ts). */
  rememberThreads?: (
    sessionId: string,
    threads: Array<{
      threadId: string;
      repo: string;
      prNumber: number;
      url: string;
      where: string | null;
      reviewer: string;
      excerpt: string;
    }>,
  ) => void;
  /** How full the session's Claude conversation is (share of its window), for the sub-agent hint. */
  contextShare?: (session: WorktreeSession) => number | null;
  /** What archiving it now would leave unfinished (replies to post, undelivered notes). Merged work
   *  doesn't wait for these — the archive keeps them — so this is only reported. */
  waiting?: (sessionId: string) => string[];
  /** After a note: start the session's Claude if it isn't running, so it works on it now. */
  wake?: (sessionId: string) => Promise<WakeResult>;
  /** Its Claude is in the middle of a turn: not archived until the turn ends. */
  busy?: (sessionId: string) => boolean;
  /** It's a repo's own checkout (`work tree <repo>`, no branch): never archived by the watch —
   *  that's where you go on working after a PR merges, on the next branch. */
  ownCheckout?: (session: WorktreeSession) => boolean;
  /** Look, never act on its own (the dev server, `work web --dev`, next to the real one): checks
   *  keep the PR state current for its dashboard, but tell no Claude, archive nothing, wake nobody.
   *  What you click (Fix CI) still happens. */
  lookOnly?: boolean;
  /** The session's Claude runs in the PTY host with permission checks off. */
  runsUnsafe?: (sessionId: string) => boolean;
  /** Review threads/comments on a PR (null when gh can't say). */
  reviewFeedback?: (repoPath: string, prNumber: number) => Promise<ReviewFeedback | null>;
  /** Per session: what was already acted on — CI head commits reported,
   *  review comments handed over (persisted, see pr-watch-store.ts). */
  told: (sessionId: string) => SeenStore;
  now?: () => number;
  /** Where its runs and decisions show (the Activity panel). */
  activity?: ActivityLog;
}

export interface PrWatch {
  /** Check every eligible session once. */
  tick(): Promise<void>;
  /** Check one session now (the header asked). */
  /** Re-check one session now. `act: false` only reports (for GETs, which
   *  must not post notes or archive). */
  refresh(id: string, opts?: { act?: boolean }): Promise<SessionCi | null>;
  state(id: string): SessionCi | null;
  /** Ask the session's Claude to fix its failing checks, now. */
  fixNow(id: string): Promise<boolean>;
  /** You replied to (or resolved) a review thread: it no longer waits on you, before the next check reads GitHub again. */
  answered(id: string, threadId: string): void;
  start(intervalMs: number, firstDelayMs?: number): () => void;
}

const CONCURRENCY = 3;
/** gh's words when GitHub's API limit is spent ("API rate limit already exceeded", "secondary rate limit"). */
export const RATE_LIMITED = /rate limit/i;
/** How long the sweeps rest after GitHub said so. */
export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;

export function ciFixMessage(
  failing: Array<{ repo: string; number: number; checks: string[] }>,
  isGroup: boolean,
  contextShare?: number | null,
): string {
  const lines = failing.map((f) => `- PR #${f.number}${isGroup ? ` (${f.repo})` : ''}: ${f.checks.join(', ')}`);
  const hint = subAgentHint(contextShare);
  return [
    'CI is failing:',
    ...lines,
    '',
    'Look at the failures (`gh pr checks <n>`, `gh run view <run-id> --log-failed`), fix them, and push.',
    `If fixing one needs a decision from me — the check is right but the fix changes behaviour, or the check itself looks wrong — don't guess: start your reply with a line \`${DECISION_MARKER} <the question>\`.`,
    ...(hint ? [hint] : []),
  ].join('\n');
}

/**
 * Archive once the session's work is merged: every repo done — or merged
 * with only uncommitted files left, which the archive saves for Restore —
 * and at least one merged PR that is THIS work.
 *
 * "This work": it was merged after the user last entered the session, or
 * its head is exactly the commit the worktree has checked out and the
 * session has been left alone for a day since it was entered. `gh pr view
 * <branch>` also returns a PR merged long ago for a reused branch name; such
 * a PR has another head than the new work, and was merged before it was
 * entered, so it never archives a fresh session. The day's grace is for
 * entering on purpose after the merge — Restore, or `work tree` onto a
 * branch still at the merged tip — which would otherwise be archived again
 * by the next sweep, before any new file was written. (The "merged after
 * you entered" rule alone disarmed a session for good once you re-entered
 * it after the merge, just to look.)
 */
export const REENTERED_GRACE_MS = 24 * 3600_000;

export function shouldAutoArchive(pre: ShipPreflight, session: Pick<WorktreeSession, 'lastAccessedAt'>, now: number): boolean {
  return autoArchiveVerdict(pre, session, now)?.archive === true;
}

/**
 * A repo the archive may take: done (ship.ts repoDone), or merged at the
 * checked-out commit with only uncommitted files left — archiving saves
 * those and Restore puts them back (archive-uncommitted.ts).
 */
function archivable(r: ShipPreflight['repos'][number]): boolean {
  if (r.done) return true;
  return r.pr?.state === 'MERGED' && !r.ahead && (!r.localSha || !r.pr.headSha || r.localSha === r.pr.headSha);
}

/** What keeps a merged repo from being archived: work after the merge that only lives in commits. */
function workBeyondMerge(r: ShipPreflight['repos'][number]): string | null {
  const parts: string[] = [];
  if (r.ahead) parts.push(`${r.ahead} unpushed commit${r.ahead === 1 ? '' : 's'}`);
  if (r.localSha && r.pr?.headSha && r.localSha !== r.pr.headSha) parts.push('a commit checked out that the PR didn’t merge');
  return parts.length ? `${r.name}: PR merged, but ${parts.join(' and ')}` : null;
}

/**
 * The same rule, with its reason, for the Activity panel: null when no PR
 * of the session is merged (nothing to decide), else whether it archives
 * and, when not, why it keeps the session.
 */
export function autoArchiveVerdict(
  pre: ShipPreflight,
  session: Pick<WorktreeSession, 'lastAccessedAt'>,
  now: number,
): { archive: true } | { archive: false; why: string } | null {
  const merged = pre.repos.filter((r) => r.pr?.state === 'MERGED');
  if (merged.length === 0) return null;
  // A repo GitHub didn't answer for may have an open PR, and one git couldn't read may hold
  // anything: never archive on a guess.
  const unread = pre.repos.filter((r) => (!r.pr && r.ghError) || r.gitError);
  if (unread.length) return { archive: false, why: `couldn't read ${unread.map((r) => r.name).join(', ')}` };
  // A merged repo isn't done while there is work beyond the merge (repoDone):
  // say which, rather than "not merged" about a merged PR.
  // Every repo that holds it, each with its reason: one merged with work left in it must not hide another not merged at all.
  const open = pre.repos.filter((r) => !archivable(r));
  if (open.length) {
    const beyond = open.map((r) => (r.pr?.state === 'MERGED' ? workBeyondMerge(r) : null));
    const notMerged = open.filter((_, i) => !beyond[i]).map((r) => r.name);
    const why = [...beyond.filter((w): w is string => !!w), ...(notMerged.length ? [`not all merged yet (${notMerged.join(', ')})`] : [])];
    return { archive: false, why: why.join('; ') };
  }
  // Uncommitted files don't hold it: archiving saves them for Restore.
  const entered = Date.parse(session.lastAccessedAt);
  let waiting = false;
  for (const r of merged) {
    const mergedAt = r.pr!.mergedAt ? Date.parse(r.pr!.mergedAt) : NaN;
    if (Number.isFinite(mergedAt) && (!Number.isFinite(entered) || mergedAt > entered)) return { archive: true };
    const sameWork = !!r.pr!.headSha && !!r.localSha && r.pr!.headSha === r.localSha;
    if (sameWork && Number.isFinite(entered)) {
      if (now - entered >= REENTERED_GRACE_MS) return { archive: true };
      waiting = true;
    }
  }
  return waiting
    ? { archive: false, why: 'you opened it after the merge; archiving once it has been left alone for a day' }
    : { archive: false, why: "the merged PR is older work on this branch name, not what's checked out" };
}

/**
 * The check with one review thread taken out, as answered: its repo's open
 * count goes down by one. The watch's thread list is GitHub as of its last
 * check (every 3 minutes), so a reply just posted would otherwise leave the
 * thread "with no reply" — in the session's Needs you line, its review count
 * and the Inbox — until then. The next check reads GitHub again: a reviewer
 * who answers brings the thread back. The same check, unchanged, when the
 * thread isn't in it. Pure.
 */
export function withoutThread(ci: SessionCi, threadId: string): SessionCi {
  if (!ci.repos.some((r) => r.threads?.some((t) => t.threadId === threadId))) return ci;
  return {
    ...ci,
    repos: ci.repos.map((r) => {
      if (!r.threads?.some((t) => t.threadId === threadId)) return r;
      const threads = r.threads.filter((t) => t.threadId !== threadId);
      const { threads: _old, ...rest } = r;
      return {
        ...rest,
        ...(r.openThreads !== undefined ? { openThreads: Math.max(0, r.openThreads - 1) } : {}),
        ...(threads.length ? { threads } : {}),
      };
    }),
  };
}

export function createPrWatch(deps: PrWatchDeps): PrWatch {
  const now = deps.now ?? Date.now;
  const states = new Map<string, SessionCi>();
  /** The last review feedback per session + repo, and the PR's updatedAt it was read at. */
  const feedbackCache = new Map<string, { number: number; updatedAt: string; fb: ReviewFeedback }>();
  /** A session's check in flight: a refresh joins it instead of starting another. */
  const inflight = new Map<string, Promise<SessionCi | null>>();
  /** Sweeps skip until then: GitHub's API limit was spent (see check). */
  let pausedUntil = 0;
  const sessionOf = (id: string) => deps.sessions().find((s) => s.id === id);

  /**
   * A seen-store whose additions wait until `commit()`. Keys for something
   * we tell Claude are only recorded once the note was delivered: marking
   * them first (and swallowing a failed send) lost that feedback for good.
   */
  function staged(id: string) {
    const pending = new Set<string>();
    return {
      has: (k: string) => pending.has(k) || deps.told(id).has(k),
      add: (k: string) => void pending.add(k),
      commit: () => {
        for (const k of pending) deps.told(id).add(k);
        pending.clear();
      },
    };
  }

  /** Send a note; on success record its keys as told. A failure keeps them
   *  un-told, so the next sweep tries again. */
  async function tellThenRecord(id: string, body: string, seen: { commit: () => void }): Promise<boolean> {
    try {
      await deps.tell(id, body);
    } catch {
      return false;
    }
    seen.commit();
    return true;
  }

  function failingOf(ci: SessionCi) {
    return ci.repos
      .filter((r) => r.pr?.state === 'OPEN' && r.pr.checks === 'fail')
      .map((r) => ({ repo: r.name, number: r.pr!.number, headSha: r.pr!.headSha, checks: (r.pr!.failing ?? []).map((f) => f.name) }));
  }

  /** One check per session at a time: a second asker gets the one running. */
  function check(id: string, session: WorktreeSession, act = true, run?: RunHandle): Promise<SessionCi | null> {
    const running = inflight.get(id);
    if (running) return running;
    const p = checkNow(id, session, act, run).finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  async function checkNow(id: string, session: WorktreeSession, act = true, run?: RunHandle): Promise<SessionCi | null> {
    const name = `${session.target} ${session.branch}`;
    const note = (text: string, level: 'info' | 'action' | 'warn' = 'info') => run?.note(`${name}: ${text}`, { level, sessionId: id });
    let pre: ShipPreflight;
    try {
      pre = await deps.preflight(session);
    } catch (err) {
      note(`couldn't check (${(err as Error).message}); keeping what it knew`, 'warn');
      return states.get(id) ?? null;
    }
    // GitHub refused: every PR reads as "none". Keep what we knew, act on
    // nothing, and let the sweeps rest (each would only spend more).
    if (pre.repos.some((r) => r.ghError && RATE_LIMITED.test(r.ghError))) {
      pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
      schedule?.pause(pausedUntil, "GitHub's API limit is spent");
      note(`GitHub says its API limit is spent: keeping what it knew, resting ${RATE_LIMIT_PAUSE_MS / 60_000} min`, 'warn');
      return states.get(id) ?? null;
    }
    const opts = deps.options();
    // Review feedback per open PR: counts for the strip, and (when acting)
    // what's new for Claude.
    const feedback: Array<{ repo: string; number: number; items: FeedbackItem[] }> = [];
    const feedbackSeen = staged(id);
    const threads = new Map<string, number>();
    const threadList = new Map<string, OpenReviewThread[]>();
    // Review text is other people's writing; a session running with
    // permission checks off would act on it unreviewed. Count threads for the
    // strip, but don't hand it over.
    const deliverReviews = !session.launchedUnsafe && !deps.runsUnsafe?.(id);
    if (deps.reviewFeedback && opts.reviewComments) {
      for (const r of pre.repos) {
        if (r.pr?.state !== 'OPEN') continue;
        // Nothing new can have been said on a PR that hasn't changed since
        // the last read (a comment or review moves its updatedAt).
        const key = `${id}:${r.name}`;
        const cached = feedbackCache.get(key);
        const fresh = cached && r.pr.updatedAt && cached.number === r.pr.number && cached.updatedAt === r.pr.updatedAt;
        const fb = fresh ? cached.fb : await deps.reviewFeedback(r.path, r.pr.number).catch(() => null);
        if (fb && !fresh && r.pr.updatedAt) feedbackCache.set(key, { number: r.pr.number, updatedAt: r.pr.updatedAt, fb });
        if (!fb) {
          // gh couldn't say this time: keep the last count for the same PR rather than drop to none.
          const was = states.get(id)?.repos.find((p) => p.name === r.name);
          if (was?.pr?.number === r.pr.number && was.openThreads !== undefined) threads.set(r.name, was.openThreads);
          if (was?.pr?.number === r.pr.number && was.threads) threadList.set(r.name, was.threads);
          continue;
        }
        threads.set(r.name, openThreadCount(fb));
        const prNumber = r.pr.number;
        threadList.set(
          r.name,
          openThreadsOf(fb, opts.trustedBots ?? DEFAULT_TRUSTED_BOTS).map((t) => ({ ...t, repo: r.name, prNumber })),
        );
        if (act && deliverReviews) {
          const items = newFeedback(fb, `${id}:${r.name}:${r.pr.number}`, feedbackSeen, {
            trustedBots: opts.trustedBots ?? DEFAULT_TRUSTED_BOTS,
          });
          if (items.length) feedback.push({ repo: r.name, number: r.pr.number, items });
        }
      }
    }
    const ci: SessionCi = {
      checkedAt: new Date(now()).toISOString(),
      repos: pre.repos.map((r) => ({
        name: r.name,
        pr: r.pr,
        done: r.done,
        ...(threads.has(r.name) ? { openThreads: threads.get(r.name)! } : {}),
        ...(threadList.get(r.name)?.length ? { threads: threadList.get(r.name)! } : {}),
      })),
    };
    const before = JSON.stringify(states.get(id)?.repos);
    states.set(id, ci);
    if (before !== JSON.stringify(ci.repos)) deps.broadcast('ci-changed', { sessionId: id });

    if (!act) return ci;
    if (feedback.length) {
      const n = feedback.reduce((k, f) => k + f.items.length, 0);
      const prs = feedback.map((f) => `#${f.number}`).join(', ');
      const what = `${n} new review comment${n === 1 ? '' : 's'} on ${prs}`;
      if (await tellThenRecord(id, reviewMessage(feedback, session.isGroup, DECISION_MARKER, deps.contextShare?.(session)), feedbackSeen)) {
        deps.rememberThreads?.(
          id,
          feedback.flatMap((f) =>
            f.items
              .filter((it) => it.threadId)
              .map((it) => ({
                threadId: it.threadId!,
                repo: f.repo,
                prNumber: f.number,
                url: it.url,
                where: it.where ?? null,
                reviewer: it.author,
                excerpt: it.body.slice(0, 400),
              })),
          ),
        );
        note(`handed ${what} to its Claude${await wakeNote(id)}`, 'action');
      } else note(`couldn't hand ${what} to its Claude; trying again next time`, 'warn');
    } else feedbackSeen.commit(); // only history / baselines: nothing to deliver
    if (opts.fixCi) {
      const fresh = failingOf(ci).filter((f) => !deps.told(id).has(`${id}:${f.repo}:${f.headSha}`));
      if (fresh.length) {
        const ciSeen = staged(id);
        for (const f of fresh) ciSeen.add(`${id}:${f.repo}:${f.headSha}`);
        const what = fresh.map((f) => `#${f.number} (${f.checks.join(', ') || 'checks'})`).join(', ');
        if (await tellThenRecord(id, ciFixMessage(fresh, session.isGroup, deps.contextShare?.(session)), ciSeen))
          note(`checks fail on ${what}: asked its Claude to fix them${await wakeNote(id)}`, 'action');
        else note(`checks fail on ${what}; couldn't reach its Claude, trying again next time`, 'warn');
      }
    }
    if (opts.autoArchive) {
      const verdict = deps.ownCheckout?.(session) ? null : autoArchiveVerdict(pre, session, now());
      // Merged work decides it: drafts, notes and questions are kept with
      // the archive, not waited for. Only a turn in progress is.
      if (verdict?.archive && deps.busy?.(id)) note('every PR merged; archiving once its Claude finishes this turn');
      else if (verdict?.archive) {
        try {
          const keptWhat = await deps.archive(id);
          const dirty = pre.repos.reduce((n, r) => n + (r.dirtyFiles || 0), 0);
          const kept = keptWhat ? `; ${keptWhat} kept for Restore` : '';
          note(
            dirty
              ? `archived: every PR merged; ${dirty} uncommitted file${dirty === 1 ? '' : 's'} saved, put back on Restore${kept} (the conversation is kept)`
              : `archived: every PR merged${kept || ', nothing uncommitted'} (the conversation is kept)`,
            'action',
          );
        } catch (err) {
          note(`every PR merged, but archiving failed: ${(err as Error).message}`, 'warn');
        }
      } else if (verdict) note(`a PR is merged, but kept: ${verdict.why}`);
    }
    return ci;
  }

  /** Start the Claude that just got a note, if it isn't running; says what happened, for the note. */
  async function wakeNote(id: string): Promise<string> {
    if (!deps.wake) return '';
    const r = await deps.wake(id).catch((): WakeResult => 'failed');
    return r === 'started'
      ? ' (started it: it resumes its conversation and works on it now)'
      : r === 'failed'
        ? " (couldn't start it: it gets the note when it next runs)"
        : '';
  }

  /** The sweep's one-line result, from what it just saw. */
  function sweepSummary(ids: string[]): string {
    let prs = 0;
    let threads = 0;
    let failing = 0;
    for (const id of ids) {
      for (const r of states.get(id)?.repos ?? []) {
        if (r.pr?.state !== 'OPEN') continue;
        prs++;
        threads += r.openThreads ?? 0;
        if (r.pr.checks === 'fail') failing++;
      }
    }
    const parts = [`${ids.length} session${ids.length === 1 ? '' : 's'}`, `${prs} open PR${prs === 1 ? '' : 's'}`];
    if (threads) parts.push(`${threads} unresolved review thread${threads === 1 ? '' : 's'}`);
    if (failing) parts.push(`${failing} failing`);
    return parts.join(' · ');
  }

  let schedule: ScheduleHandle | undefined;

  let running: Promise<void> | null = null;
  const watch: PrWatch = {
    tick() {
      if (now() < pausedUntil) {
        deps.activity?.skip('pr-watch', 'Checking pull requests', "GitHub's API limit is spent; resting");
        return Promise.resolve();
      }
      // One sweep at a time: a slow gh must not stack sweeps up.
      running ??= (async () => {
        schedule?.resume();
        const queue = deps.sessions();
        const ids = queue.map((q) => q.id);
        const run = deps.activity?.start('pr-watch', 'Checking pull requests');
        let done = 0;
        run?.progress(0, ids.length);
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            await check(next.id, next.session, !deps.lookOnly, run);
            run?.progress(++done, ids.length);
          }
        };
        try {
          await Promise.all(Array.from({ length: CONCURRENCY }, worker));
          run?.done(sweepSummary(ids));
        } catch (err) {
          run?.fail((err as Error).message);
          throw err;
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },
    async refresh(id, opts) {
      const s = sessionOf(id);
      return s ? check(id, s.session, !deps.lookOnly && (opts?.act ?? true)) : null;
    },
    state: (id) => states.get(id) ?? null,
    answered(id, threadId) {
      const was = states.get(id);
      if (!was) return;
      const ci = withoutThread(was, threadId);
      if (ci === was) return;
      states.set(id, ci);
      deps.broadcast('ci-changed', { sessionId: id });
    },
    // Your click, not a sweep: a look-only watch does it too (the told-keys are shared, so no one repeats it).
    async fixNow(id) {
      const s = sessionOf(id);
      const ci = s ? await check(id, s.session, false) : null;
      if (!s || !ci) return false;
      const failing = failingOf(ci);
      if (!failing.length) return false;
      const seen = staged(id);
      for (const f of failing) seen.add(`${id}:${f.repo}:${f.headSha}`);
      await deps.tell(id, ciFixMessage(failing, s.session.isGroup, deps.contextShare?.(s.session))); // the route reports a failure
      seen.commit();
      return true;
    },
    start(intervalMs, firstDelayMs = 15_000) {
      schedule = deps.activity?.schedule('pr-watch', 'Pull request check', intervalMs);
      schedule?.next(now() + firstDelayMs);
      const tickAndPlan = () => {
        schedule?.next(now() + intervalMs);
        void watch.tick();
      };
      const first = setTimeout(tickAndPlan, firstDelayMs);
      const every = setInterval(tickAndPlan, intervalMs);
      first.unref?.();
      every.unref?.();
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
  return watch;
}
