/**
 * Starting a session on someone else's pull request — on their branch, so
 * what you push lands in their PR. Pure (the SPA and the demo use it): how a
 * PR is named, and what its session's Claude is told first. The lookup
 * (`gh pr view`) is `pr-start.ts`.
 */

import type { PrToStart } from '../api-types.js';

export type { PrToStart };

/** A PR as you'd name it: its link (repo known), or its number (in a repo you pick). */
export interface PrRef {
  /** `owner/name`, lowercase, from a link. */
  repo?: string;
  number: number;
}

/** A PR link (`https://github.com/owner/repo/pull/123`, any tail), `#123` or `123`; null for anything else. */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (url) return { repo: `${url[1]}/${url[2]}`.toLowerCase(), number: Number(url[3]) };
  const n = /^#?(\d+)$/.exec(s);
  return n && Number(n[1]) > 0 ? { number: Number(n[1]) } : null;
}

/**
 * The first message to the session's Claude: whose PR this is, that what it
 * pushes lands there, and to get up to speed — then do `instruction`, or
 * with none, say where it stands and wait for what the user wants. Nothing
 * on GitHub (no comments, reviews or replies): that's the author's
 * conversation.
 */
export function workOnPrPrompt(pr: Pick<PrToStart, 'number' | 'title' | 'url'> & { author?: string }, instruction?: string): string {
  const who = pr.author ? `@${pr.author}` : 'its author';
  const todo = instruction?.trim();
  const upToSpeed = `Get up to speed first (gh pr view ${pr.number}, gh pr diff ${pr.number})`;
  return [
    `Work on PR #${pr.number} by ${who}: ${pr.title}`,
    pr.url,
    '',
    `This worktree is on ${who}'s branch: what you commit and push lands in their PR.`,
    ...(todo ? [`${upToSpeed}, then:`, '', todo, ''] : [`${upToSpeed}, tell me where it stands, and wait for what I want done.`]),
    "Don't post on GitHub (no comments, reviews or replies).",
  ].join('\n');
}
