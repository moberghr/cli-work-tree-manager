/**
 * Starting a session on someone else's pull request — on their branch, so
 * what you push lands in their PR. Pure (the SPA and the demo use it): how a
 * PR is named, and what its session's Claude is told first. The lookup
 * (the repo's host) is `pr-start.ts`.
 */

import type { PrToStart } from '../api-types.js';
import { commandsFor, DEFAULT_HOST } from '../hosts/commands.js';
import { parsePrLink } from '../hosts/links.js';

export type { PrToStart };

/** A PR as you'd name it: its link (repo known), or its number (in a repo you pick). */
export interface PrRef {
  /** The repo's id on its host, from a link (GitHub: `owner/name`, lowercase). */
  repo?: string;
  /** The host a link is on. */
  host?: string;
  number: number;
}

/** A PR link of a host work knows (any tail), `#123` or `123`; null for anything else. */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const link = parsePrLink(s);
  if (link) return { repo: link.repoId, ...(link.host === DEFAULT_HOST ? {} : { host: link.host }), number: link.number };
  const n = /^#?(\d+)$/.exec(s);
  return n && Number(n[1]) > 0 ? { number: Number(n[1]) } : null;
}

/**
 * The first message to the session's Claude: whose PR this is, that what it
 * pushes lands there, and to get up to speed — then do `instruction`, or
 * with none, say where it stands and wait for what the user wants. Nothing
 * on the host (no comments, reviews or replies): that's the author's
 * conversation. Its commands are the PR's host's (`host`; GitHub's when absent).
 */
export function workOnPrPrompt(
  pr: Pick<PrToStart, 'number' | 'title' | 'url'> & { author?: string; host?: string },
  instruction?: string,
): string {
  const cmd = commandsFor(pr.host);
  const who = pr.author ? `@${pr.author}` : 'its author';
  const todo = instruction?.trim();
  const upToSpeed = `Get up to speed first (${cmd.view(pr.number)}, ${cmd.diff(pr.number)})`;
  return [
    `Work on PR #${pr.number} by ${who}: ${pr.title}`,
    pr.url,
    '',
    `This worktree is on ${who}'s branch: what you commit and push lands in their PR.`,
    ...(todo ? [`${upToSpeed}, then:`, '', todo, ''] : [`${upToSpeed}, tell me where it stands, and wait for what I want done.`]),
    `Don't post on ${cmd.host} (no comments, reviews or replies).`,
  ].join('\n');
}
