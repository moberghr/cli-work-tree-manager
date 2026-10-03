/**
 * PURE — the "blocked by" rules (session-blocks.ts stores them), shared with
 * the demo; keep it import-free.
 */

export type BlockRef =
  | { kind: 'session'; id: string; label: string }
  | { kind: 'pr'; url: string; label: string; state?: 'OPEN' | 'MERGED' | 'CLOSED' };

export interface SessionBlock {
  by: BlockRef[];
  at: string;
}

export const MAX_BLOCKERS = 10;

/** A blocker's key: one per thing waited on. Pure. */
export const blockKey = (b: Pick<BlockRef, 'kind'> & { id?: string; url?: string }): string => (b.kind === 'session' ? `session:${b.id}` : `pr:${b.url}`);

/** A GitHub pull request URL, normalized (…/pull/12, no trailing path, query or hash); null when it isn't one. Pure. */
export function prUrl(text: string): { url: string; label: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(text.trim());
  return m ? { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, label: `${m[2]}#${m[3]}` } : null;
}

/** Is it done (so it no longer blocks)? `sessionGone(id)`: archived or deleted. Pure. */
export function blockerDone(b: BlockRef, sessionGone: (id: string) => boolean): boolean {
  return b.kind === 'session' ? sessionGone(b.id) : b.state === 'MERGED' || b.state === 'CLOSED';
}

/** What its Claude is told when the wait is over. Pure. */
export function unblockedPrompt(done: BlockRef[]): string {
  const what = done.map((b) => (b.kind === 'pr' ? `${b.label} (${b.state === 'CLOSED' ? 'closed, not merged' : 'merged'})` : `${b.label} (done)`)).join(', ');
  return `What this session was waiting on is done: ${what}. Bring the branch up to date if it needs the change (work update), then carry on. If something there changes the plan, start a line with DECISION NEEDED: and ask.`;
}
