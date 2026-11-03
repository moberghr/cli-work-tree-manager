import { loadConfig } from '../platform/config.js';
import { defaultRunner } from '../platform/command-runner.js';
import { hostForRepo } from '../hosts/index.js';
import { runInternal } from '../diff/checkpoint-summary.js';
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

/**
 * The review queue and its routes' I/O, real: the repos from config, each on
 * its own host, git through the default runner, the summarising agent for
 * the AI step (with the time a big diff takes), state.db for the reviews.
 * work web composes these (web-server.ts); tests use the parts.
 */

/** How long the AI step may take: a large PR's logic is a long prompt. */
const AGENT_TIMEOUT_MS = 180_000;

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
