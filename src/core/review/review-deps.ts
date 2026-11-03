import { loadConfig } from '../platform/config.js';
import { defaultRunner, type CommandRunner } from '../platform/command-runner.js';
import { hostForRepo } from '../hosts/index.js';
import { internalReadOnly, runInternal, runInternalReadOnly } from '../diff/checkpoint-summary.js';
import type { AgentReadOnly } from '../agents/types.js';
import { sweepReviewTrees, withReviewTree, type ReviewTreeAt } from './review-tree.js';
import { bootTime, isPidAlive } from '../platform/process.js';
import { setReviewMode } from '../worktree/repo-admin.js';
import type { ReviewEvent, ReviewSettingsWire } from '../api-types.js';
import type { WorkConfig } from '../platform/config.js';
import type { ActivityLog } from '../platform/activity.js';
import { rulesWith } from './change-kinds.js';
import { reviewLimits, reviewModeOf, reviewProjects } from './review-config.js';
import { createReviewQueue, type ReviewQueue, type ReviewQueueDeps } from './review-queue.js';
import { dropReviewRef, preparePr, reviewDiff, reviewRef } from './review-source.js';
import { allReviews, keepOnly, readReview, updateReview, upsertReview } from './review-store.js';
import { preparedOn } from './review-submit.js';
import fs from 'node:fs';
import type { FixMyselfDeps } from './review-fix.js';
import { sessionOnBranch } from './review-fix.js';
import { resolvePrToStart } from '../pr/pr-start.js';
import { loadHistory } from '../sessions/history.js';
import { checkedOutBranch } from '../git/git-head.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { CreateWorktree } from '../worktree/setup-child.js';
import { startSessionWithPrompt } from '../sessions/session-start.js';

/**
 * The review queue and its routes' I/O, real: the repos from config, each on
 * its own host, git through the default runner, the summarising agent for
 * the AI step (with the time a big diff takes), state.db for the reviews.
 * work web composes these (web-server.ts); tests use the parts.
 */

/** How long the AI step may take: a large PR's logic is a long prompt. */
const AGENT_TIMEOUT_MS = 180_000;

/** How long the AI step may take in a checkout of the PR: it reads files (callers, interfaces, tests) besides the diff. */
export const CHECKOUT_AGENT_TIMEOUT_MS = 300_000;

/** A temporary checkout younger than this may be another work web's, still read (the dev server's click): not swept. */
const TREE_SWEEP_MIN_AGE_MS = CHECKOUT_AGENT_TIMEOUT_MS + 5 * 60_000;

/**
 * The AI step read-only in a temporary checkout of the PR (review-tree.ts), removed whatever happens: null when the
 * summarising agent has no read-only mode. Its I/O passed in for tests.
 */
export async function agentInCheckout(
  at: ReviewTreeAt,
  prompt: string,
  io: {
    run: CommandRunner;
    /** The summarising agent's read-only run (its rule for settings files); null: it has none. */
    readOnly: () => Pick<AgentReadOnly, 'isSettingsFile'> | null;
    agent: (prompt: string, cwd: string) => Promise<string | null>;
    root?: string;
  },
): Promise<{ answer: string | null; why?: string } | null> {
  const mode = io.readOnly();
  if (!mode) return null;
  const r = await withReviewTree(io.run, at, (dir) => io.agent(prompt, dir), {
    strip: (rel) => mode.isSettingsFile(rel),
    ...(io.root ? { root: io.root } : {}),
  });
  if (!r.ok) return { answer: null, why: r.error };
  const left = r.left ? ` (its checkout ${r.left} wouldn't go: the next start sweeps it)` : '';
  return r.value
    ? { answer: r.value, ...(left ? { why: left.trim() } : {}) }
    : { answer: null, why: `no answer: it failed or took over ${CHECKOUT_AGENT_TIMEOUT_MS / 60_000} minutes${left}` };
}

/** config.json, or an empty one (no repos: nothing to review). */
const configNow = (): Pick<WorkConfig, 'repos' | 'groups' | 'reviews'> => loadConfig() ?? { repos: {}, groups: {} };

export function realReviewQueueDeps(opts: { activity?: ActivityLog; changed: () => void }): ReviewQueueDeps {
  const config = configNow;
  return {
    projects: () => reviewProjects(config()),
    hostOf: (repoPath) => hostForRepo(repoPath).host,
    run: defaultRunner,
    prepare: (repoPath, host, pr) => preparePr(defaultRunner, repoPath, host, pr),
    dropRef: (repoPath, number) => dropReviewRef(defaultRunner, repoPath, number),
    agent: (prompt) => runInternal(prompt, AGENT_TIMEOUT_MS),
    checkoutLines: () => internalReadOnly()?.promptLines ?? null,
    agentInCheckout: (at, prompt) =>
      agentInCheckout(at, prompt, {
        run: defaultRunner,
        readOnly: internalReadOnly,
        agent: (p, cwd) => runInternalReadOnly(p, cwd, CHECKOUT_AGENT_TIMEOUT_MS),
      }),
    sweepTrees: () => sweepReviewTrees(defaultRunner, { olderThanMs: TREE_SWEEP_MIN_AGE_MS }),
    rules: () => rulesWith(config().reviews?.rules),
    store: { read: readReview, upsert: upsertReview, all: allReviews, keepOnly },
    limits: () => reviewLimits(config()),
    changed: opts.changed,
    ...(opts.activity ? { activity: opts.activity } : {}),
  };
}

export function realReviewQueue(opts: { activity?: ActivityLog; changed: () => void }): ReviewQueue {
  return createReviewQueue(realReviewQueueDeps(opts));
}

/** Each repo and group with its mode, for the Repos page. */
export function reviewSettings(): ReviewSettingsWire {
  const config = configNow();
  const set = config.reviews?.projects ?? {};
  return {
    projects: [
      ...Object.keys(config.repos).map((name) => ({ name, kind: 'repo' as const, ...reviewModeOf(name, config) })),
      ...Object.keys(config.groups ?? {}).map((name) => ({
        name,
        kind: 'group' as const,
        mode: set[name] ?? 'all',
        from: set[name] ? ('repo' as const) : ('default' as const),
      })),
    ],
    ...reviewLimits(config),
  };
}

/** What the review routes reach outside, real. */
export function realReviewRouteIo() {
  return {
    read: readReview,
    all: allReviews,
    update: updateReview,
    limits: () => reviewLimits(configNow()),
    today: () => preparedOn(allReviews(), new Date()),
    repoPath: (alias: string) => loadConfig()?.repos[alias] ?? null,
    diff: (repoPath: string, from: string, number: number) => reviewDiff(defaultRunner, repoPath, from, reviewRef(number)),
    submit: (
      repoPath: string,
      number: number,
      review: { commitId: string; event: ReviewEvent; body: string; comments: Array<{ path: string; line: number; body: string }> },
    ) => hostForRepo(repoPath).host.submitReview(defaultRunner, repoPath, number, review),
    // Whose submit claim it is: this process, and whether another's still runs.
    pid: process.pid,
    bootedAt: bootTime,
    alive: isPidAlive,
    settings: reviewSettings,
    setMode: setReviewMode,
  };
}

/**
 * Fix it myself's session side, real: the PR looked up as Start's Work on it does, the live session on its branch
 * from the history, a new one made through `create` (work web's `makeWorktree`, in a child) and started in the PTY
 * host, a note through `note` (work web's comment route).
 */
export function realFixIo(opts: {
  create: CreateWorktree;
  note: (sessionId: string, body: string) => Promise<void>;
  activity?: ActivityLog;
}): Omit<FixMyselfDeps, 'read' | 'update'> {
  return {
    lookUp: (r) => resolvePrToStart(r.url, loadConfig() ?? { repos: {}, groups: {} }, r.repo),
    liveSessionOn: (alias, branch) =>
      sessionOnBranch(loadHistory(), loadConfig(), alias, branch, { branchOf: checkedOutBranch, exists: (p) => fs.existsSync(p) }),
    create: async (alias, branch, name) => {
      const config = loadConfig();
      if (!config) return { ok: false, error: 'no config' };
      const made = await opts.create({ target: alias, branch, name }, config);
      if (!made.ok) return made;
      return {
        ok: true,
        sessionId: sessionIdFor({ target: alias, branch: made.branch }),
        label: `${alias} · ${made.branch}`,
        ...(made.warnings?.length ? { warnings: made.warnings } : {}),
      };
    },
    start: startSessionWithPrompt,
    note: opts.note,
    ...(opts.activity ? { activity: opts.activity } : {}),
  };
}
