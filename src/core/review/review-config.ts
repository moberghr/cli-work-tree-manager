import type { ReviewMode } from '../api-types.js';

/**
 * PURE — which repos get automatic reviews, and the limits (#64). A project
 * is a repo alias or a group; a repo's own setting wins, then the first
 * group (in config order) that names it and has one, then `all`.
 */

/** No daily cap unless config sets one (`reviews.maxPerDay`): a new head is reviewed whenever it comes. */
export const DEFAULT_MAX_PER_DAY: number | null = null;
export const DEFAULT_MAX_LINES = 3000;

export interface ReviewConfig {
  repos: Record<string, string>;
  groups?: Record<string, string[]>;
  reviews?: { projects?: Record<string, ReviewMode>; maxPerDay?: number; maxLines?: number };
}

/** A repo's mode, and where it comes from (its own setting, a group's, or the default). */
export function reviewModeOf(
  alias: string,
  config: ReviewConfig,
): { mode: ReviewMode; from: 'repo' | 'group' | 'default'; group?: string } {
  const set = config.reviews?.projects ?? {};
  if (set[alias]) return { mode: set[alias], from: 'repo' };
  for (const [group, members] of Object.entries(config.groups ?? {}))
    if (members.includes(alias) && set[group]) return { mode: set[group], from: 'group', group };
  return { mode: 'all', from: 'default' };
}

/** Every enrolled repo with its mode: what the queue sweeps. */
export function reviewProjects(config: ReviewConfig): Array<{ alias: string; path: string; mode: ReviewMode }> {
  return Object.entries(config.repos).map(([alias, path]) => ({ alias, path, mode: reviewModeOf(alias, config).mode }));
}

export function reviewLimits(config: Pick<ReviewConfig, 'reviews'>): { maxPerDay: number | null; maxLines: number } {
  return {
    maxPerDay: config.reviews?.maxPerDay ?? DEFAULT_MAX_PER_DAY,
    maxLines: config.reviews?.maxLines ?? DEFAULT_MAX_LINES,
  };
}

export const isReviewMode = (v: unknown): v is ReviewMode => v === 'all' || v === 'asked' || v === 'off';
