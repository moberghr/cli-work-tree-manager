import { attentionItems } from './review-plan.js';

/**
 * What a review of these repos is told to pay attention to (asked for: a way to tell reviews what matters, for
 * everyone or for one repo): the list for every review (config `reviews.focus`), then each repo's own
 * (`reviews.focusFor[alias]`), each once. Your own words from work's config — never from the repository, whose files
 * a pull request can change. Pure.
 */
export function reviewFocus(
  config: { reviews?: { focus?: string[]; focusFor?: Record<string, string[]> } } | null | undefined,
  aliases: readonly string[],
): string[] {
  const r = config?.reviews;
  return attentionItems(r?.focus, ...[...new Set(aliases)].map((a) => r?.focusFor?.[a]));
}
