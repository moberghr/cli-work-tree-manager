import path from 'node:path';
import type { WorktreeSession } from '../sessions/session-types.js';

/**
 * A session on a repo's own checkout (`work tree <repo>` with no branch):
 * the repo's folder itself, not a worktree work made. Branches are work's to
 * manage — a new piece of work gets its own worktree — so that checkout stays
 * on its branch: its Claude is told so on every prompt (the turn-start hook),
 * and the PR watch never archives it.
 */

const key = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Whether the session's folder is one of the configured repos' own folders. */
export function isOwnCheckout(s: Pick<WorktreeSession, 'paths'>, repos: Record<string, string>): boolean {
  const own = new Set(Object.values(repos).map(key));
  return s.paths.some((p) => own.has(key(p)));
}

/** What its Claude is told at the start of each turn there. Pure. */
export function ownCheckoutNote(s: Pick<WorktreeSession, 'target' | 'branch'>): string {
  const branch = s.branch || 'its branch';
  return (
    `[work] This folder is ${s.target}'s own checkout, which work keeps on ${branch}. ` +
    `Don't create, switch or check out branches here, and don't open pull requests from it — work manages branches. ` +
    `If the task needs a branch of its own, say so and ask the user to start a worktree for it (\`work tree ${s.target} <branch>\`).`
  );
}
