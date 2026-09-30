import type { WorktreeSession } from './session-types.js';
import type { SessionCi, ShipPreflight } from './api-types.js';
import { DECISION_MARKER } from './attention.js';
import { newFeedback, openThreadCount, reviewMessage, type FeedbackItem, type ReviewFeedback, type SeenStore } from './pr-review.js';

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
  archive: (id: string) => Promise<void>;
  /** Leave the session's Claude a (published) review note. */
  tell: (id: string, body: string) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  options: () => { autoArchive: boolean; fixCi: boolean; reviewComments: boolean };
  /** Its Claude is working or waiting for you: never archived then. */
  busy?: (sessionId: string) => boolean;
  /** The session's Claude runs in the PTY host with permission checks off. */
  runsUnsafe?: (sessionId: string) => boolean;
  /** Review threads/comments on a PR (null when gh can't say). */
  reviewFeedback?: (repoPath: string, prNumber: number) => Promise<ReviewFeedback | null>;
  /** Per session: what was already acted on — CI head commits reported,
   *  review comments handed over (persisted, see pr-watch-store.ts). */
  told: (sessionId: string) => SeenStore;
  now?: () => number;
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
  start(intervalMs: number, firstDelayMs?: number): () => void;
}

const CONCURRENCY = 3;
/** gh's words when GitHub's API limit is spent ("API rate limit already exceeded", "secondary rate limit"). */
export const RATE_LIMITED = /rate limit/i;
/** How long the sweeps rest after GitHub said so. */
export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;

export function ciFixMessage(failing: Array<{ repo: string; number: number; checks: string[] }>, isGroup: boolean): string {
  const lines = failing.map(
    (f) => `- PR #${f.number}${isGroup ? ` (${f.repo})` : ''}: ${f.checks.join(', ')}`,
  );
  return [
    'CI is failing:',
    ...lines,
    '',
    'Look at the failures (`gh pr checks <n>`, `gh run view <run-id> --log-failed`), fix them, and push.',
    `If fixing one needs a decision from me — the check is right but the fix changes behaviour, or the check itself looks wrong — don't guess: start your reply with a line \`${DECISION_MARKER} <the question>\`.`,
  ].join('\n');
}

/**
 * Archive once the session's work is merged: every repo done, nothing
 * uncommitted anywhere, and at least one merged PR that is THIS work.
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
  if (pre.repos.length === 0 || !pre.repos.every((r) => r.done)) return false;
  if (pre.repos.some((r) => r.dirtyFiles > 0)) return false;
  const entered = Date.parse(session.lastAccessedAt);
  return pre.repos.some((r) => {
    if (r.pr?.state !== 'MERGED') return false;
    const merged = r.pr.mergedAt ? Date.parse(r.pr.mergedAt) : NaN;
    if (Number.isFinite(merged) && (!Number.isFinite(entered) || merged > entered)) return true;
    const sameWork = !!r.pr.headSha && !!r.localSha && r.pr.headSha === r.localSha;
    return sameWork && Number.isFinite(entered) && now - entered >= REENTERED_GRACE_MS;
  });
}

export function createPrWatch(deps: PrWatchDeps): PrWatch {
  const now = deps.now ?? Date.now;
  const states = new Map<string, SessionCi>();
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

  async function check(id: string, session: WorktreeSession, act = true): Promise<SessionCi | null> {
    let pre: ShipPreflight;
    try {
      pre = await deps.preflight(session);
    } catch {
      return states.get(id) ?? null;
    }
    // GitHub refused: every PR reads as "none". Keep what we knew, act on
    // nothing, and let the sweeps rest (each would only spend more).
    if (pre.repos.some((r) => r.ghError && RATE_LIMITED.test(r.ghError))) {
      pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
      return states.get(id) ?? null;
    }
    const opts = deps.options();
    // Review feedback per open PR: counts for the strip, and (when acting)
    // what's new for Claude.
    const feedback: Array<{ repo: string; number: number; items: FeedbackItem[] }> = [];
    const feedbackSeen = staged(id);
    const threads = new Map<string, number>();
    // Review text is other people's writing; a session running with
    // permission checks off would act on it unreviewed. Count threads for the
    // strip, but don't hand it over.
    const deliverReviews = !session.launchedUnsafe && !deps.runsUnsafe?.(id);
    if (deps.reviewFeedback && opts.reviewComments) {
      for (const r of pre.repos) {
        if (r.pr?.state !== 'OPEN') continue;
        const fb = await deps.reviewFeedback(r.path, r.pr.number).catch(() => null);
        if (!fb) {
          // gh couldn't say this time: keep the last count for the same PR rather than drop to none.
          const was = states.get(id)?.repos.find((p) => p.name === r.name);
          if (was?.pr?.number === r.pr.number && was.openThreads !== undefined) threads.set(r.name, was.openThreads);
          continue;
        }
        threads.set(r.name, openThreadCount(fb));
        if (act && deliverReviews) {
          const items = newFeedback(fb, `${id}:${r.name}:${r.pr.number}`, feedbackSeen);
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
      })),
    };
    const before = JSON.stringify(states.get(id)?.repos);
    states.set(id, ci);
    if (before !== JSON.stringify(ci.repos)) deps.broadcast('ci-changed', { sessionId: id });

    if (!act) return ci;
    if (feedback.length) await tellThenRecord(id, reviewMessage(feedback, session.isGroup, DECISION_MARKER), feedbackSeen);
    else feedbackSeen.commit(); // only history / baselines: nothing to deliver
    if (opts.fixCi) {
      const fresh = failingOf(ci).filter((f) => !deps.told(id).has(`${id}:${f.repo}:${f.headSha}`));
      if (fresh.length) {
        const ciSeen = staged(id);
        for (const f of fresh) ciSeen.add(`${id}:${f.repo}:${f.headSha}`);
        await tellThenRecord(id, ciFixMessage(fresh, session.isGroup), ciSeen);
      }
    }
    if (opts.autoArchive && !deps.busy?.(id) && shouldAutoArchive(pre, session, now())) {
      await deps.archive(id).catch(() => {});
    }
    return ci;
  }

  let running: Promise<void> | null = null;
  const watch: PrWatch = {
    tick() {
      if (now() < pausedUntil) return Promise.resolve();
      // One sweep at a time: a slow gh must not stack sweeps up.
      running ??= (async () => {
        const queue = deps.sessions();
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) await check(next.id, next.session);
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      })().finally(() => {
        running = null;
      });
      return running;
    },
    async refresh(id, opts) {
      const s = sessionOf(id);
      return s ? check(id, s.session, opts?.act ?? true) : null;
    },
    state: (id) => states.get(id) ?? null,
    async fixNow(id) {
      const s = sessionOf(id);
      const ci = s ? await check(id, s.session, false) : null;
      if (!s || !ci) return false;
      const failing = failingOf(ci);
      if (!failing.length) return false;
      const seen = staged(id);
      for (const f of failing) seen.add(`${id}:${f.repo}:${f.headSha}`);
      await deps.tell(id, ciFixMessage(failing, s.session.isGroup)); // the route reports a failure
      seen.commit();
      return true;
    },
    start(intervalMs, firstDelayMs = 15_000) {
      const first = setTimeout(() => void watch.tick(), firstDelayMs);
      const every = setInterval(() => void watch.tick(), intervalMs);
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
