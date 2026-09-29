import type { WorktreeSession } from './session-types.js';
import type { SessionCi, ShipPreflight } from './api-types.js';
import { DECISION_MARKER } from './attention.js';
import { newFeedback, openThreadCount, reviewMessage, type FeedbackItem, type ReviewFeedback } from './pr-review.js';

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
  /** Review threads/comments on a PR (null when gh can't say). */
  reviewFeedback?: (repoPath: string, prNumber: number) => Promise<ReviewFeedback | null>;
  /** Head commits we already reported a failure for (persisted). */
  told: { has: (key: string) => boolean; add: (key: string) => void };
  now?: () => number;
}

export interface PrWatch {
  /** Check every eligible session once. */
  tick(): Promise<void>;
  /** Check one session now (the header asked). */
  refresh(id: string): Promise<SessionCi | null>;
  state(id: string): SessionCi | null;
  /** Ask the session's Claude to fix its failing checks, now. */
  fixNow(id: string): Promise<boolean>;
  start(intervalMs: number, firstDelayMs?: number): () => void;
}

const CONCURRENCY = 3;

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

export function createPrWatch(deps: PrWatchDeps): PrWatch {
  const now = deps.now ?? Date.now;
  const states = new Map<string, SessionCi>();
  const sessionOf = (id: string) => deps.sessions().find((s) => s.id === id);

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
    const opts = deps.options();
    // Review feedback per open PR: counts for the strip, and (when acting)
    // what's new for Claude.
    const feedback: Array<{ repo: string; number: number; items: FeedbackItem[] }> = [];
    const threads = new Map<string, number>();
    if (deps.reviewFeedback && opts.reviewComments) {
      for (const r of pre.repos) {
        if (r.pr?.state !== 'OPEN') continue;
        const fb = await deps.reviewFeedback(r.path, r.pr.number).catch(() => null);
        if (!fb) continue;
        threads.set(r.name, openThreadCount(fb));
        if (act) {
          const items = newFeedback(fb, `${id}:${r.name}:${r.pr.number}`, deps.told);
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
    if (feedback.length) await deps.tell(id, reviewMessage(feedback, session.isGroup, DECISION_MARKER)).catch(() => {});
    if (opts.fixCi) {
      const fresh = failingOf(ci).filter((f) => !deps.told.has(`${id}:${f.repo}:${f.headSha}`));
      if (fresh.length) {
        for (const f of fresh) deps.told.add(`${id}:${f.repo}:${f.headSha}`);
        await deps.tell(id, ciFixMessage(fresh, session.isGroup)).catch(() => {});
      }
    }
    if (opts.autoArchive && pre.repos.length > 0 && pre.repos.every((r) => r.done) && pre.repos.some((r) => r.pr?.state === 'MERGED')) {
      await deps.archive(id).catch(() => {});
    }
    return ci;
  }

  let running: Promise<void> | null = null;
  const watch: PrWatch = {
    tick() {
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
    async refresh(id) {
      const s = sessionOf(id);
      return s ? check(id, s.session) : null;
    },
    state: (id) => states.get(id) ?? null,
    async fixNow(id) {
      const s = sessionOf(id);
      const ci = s ? await check(id, s.session, false) : null;
      if (!s || !ci) return false;
      const failing = failingOf(ci);
      if (!failing.length) return false;
      for (const f of failing) deps.told.add(`${id}:${f.repo}:${f.headSha}`);
      await deps.tell(id, ciFixMessage(failing, s.session.isGroup));
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
