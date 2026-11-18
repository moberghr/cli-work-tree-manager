import path from 'node:path';
import type { WorktreeSession } from '../sessions/session-types.js';
import { checkedOutBranch } from '../git/git-head.js';

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

/**
 * `branch` is the one a repo's own folder is on (reported: New worktree with "main" said the branch is already
 * checked out, while `work tree <repo>` opened it). A branch can be checked out in one place, so asking for that one
 * means the repo's own checkout: the same as naming no branch. Never for a group (it has no one checkout). The
 * branch is read from the HEAD file: no git.
 */
export function ownsBranch(
  target: string,
  branch: string,
  config: { repos: Record<string, string>; groups?: Record<string, string[]> },
  read: (checkout: string) => string | null = checkedOutBranch,
): boolean {
  if (!branch || config.groups?.[target]) return false;
  const repo = config.repos[target];
  return !!repo && read(repo) === branch;
}

/**
 * The projects as the New worktree dialog lists them: each repo with the branch its own folder is on now (reported:
 * a session started with no branch name landed on a feature branch the repo's folder had been left on, not on main —
 * the dialog didn't say where "the project as it is" was). `ownBranch` null: detached, or its folder can't be read.
 * The branch is read from the HEAD file: no git.
 */
export function projectList(
  config: { repos: Record<string, string>; groups?: Record<string, string[]> },
  read: (checkout: string) => string | null = checkedOutBranch,
): {
  singles: Array<{ name: string; kind: 'single'; path: string; ownBranch: string | null }>;
  groups: Array<{ name: string; kind: 'group'; members: string[] }>;
} {
  return {
    singles: Object.entries(config.repos).map(([name, p]) => ({ name, kind: 'single' as const, path: p, ownBranch: read(p) })),
    groups: Object.entries(config.groups ?? {}).map(([name, members]) => ({ name, kind: 'group' as const, members })),
  };
}
