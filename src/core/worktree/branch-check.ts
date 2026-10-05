import os from 'node:os';
import type { BranchCheck } from '../api-types.js';
import type { WorkConfig } from '../platform/config.js';
import { git } from '../git/git.js';
import { findSession, loadHistory } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { resolveProjectTarget } from './resolve.js';
import { firstFreeBranch } from './branch-name.js';

export interface BranchCheckDeps {
  /** A branch of that name in that repo, local or on origin (a tag or a SHA is no clash). */
  branchExists: (repoPath: string, branch: string) => boolean;
  validBranch: (name: string) => boolean;
  sessions: () => WorktreeSession[];
}

export const realBranchCheckDeps: BranchCheckDeps = {
  branchExists: (repoPath, branch) =>
    ['refs/heads/', 'refs/remotes/origin/'].some(
      (prefix) => git(['show-ref', '--verify', '--quiet', `${prefix}${branch}`], repoPath).exitCode === 0,
    ),
  validBranch: (name) => !name.startsWith('-') && git(['check-ref-format', '--branch', name], os.tmpdir()).exitCode === 0,
  sessions: loadHistory,
};

/**
 * Before the New worktree dialog creates: is this branch new for the
 * project? `work tree` checks out a branch that exists (local, then
 * origin) and reuses a session of that name, so a suggested name like
 * `fix/tests` could land new work on old commits, or hand the prompt to an
 * old conversation. Says whether the branch exists in any of the project's
 * repos, which session has it, whether git takes the name, and the first
 * free one from it (`fix/tests`, `fix/tests-2`, … `-9`; null when none is).
 * A read: git show-ref only.
 */
export function checkBranch(target: string, branch: string, config: WorkConfig, deps: BranchCheckDeps = realBranchCheckDeps): BranchCheck {
  const resolved = resolveProjectTarget(target, config);
  const repoPaths = resolved ? resolved.repoAliases.flatMap((a) => (config.repos[a] ? [config.repos[a]] : [])) : [];
  const history = deps.sessions();
  const taken = (name: string) => !!findSession(history, target, name) || repoPaths.some((p) => deps.branchExists(p, name));
  const s = findSession(history, target, branch);
  const valid = deps.validBranch(branch);
  return {
    branch,
    valid,
    exists: repoPaths.some((p) => deps.branchExists(p, branch)),
    session: s ? { id: sessionIdFor(s), archived: !!s.archivedAt } : null,
    free: valid ? firstFreeBranch(branch, taken) : null,
  };
}
