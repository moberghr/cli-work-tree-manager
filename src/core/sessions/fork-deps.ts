import os from 'node:os';
import { loadConfig } from '../platform/config.js';
import type { ForkDeps } from './fork.js';
import { checkedOutBranch } from '../git/git-head.js';
import { getStatusChecked, git } from '../git/git.js';
import type { WorktreeSession } from './session-types.js';
import { resolveProjectTarget } from '../worktree/resolve.js';
import { createInProcess, type CreateWorktree } from '../worktree/setup-child.js';
import { sessionIdFor } from './session-id.js';
import { sessionAliases } from './session-repos.js';
import { startSessionWithPrompt } from './session-start.js';

/** `work fork`'s and the Fork… route's real inputs (fork.ts). */

/** Uncommitted files across its repos (git status); null when git couldn't tell for one of them. */
export function uncommittedFiles(s: Pick<WorktreeSession, 'paths'>): number | null {
  let n = 0;
  for (const p of s.paths) {
    const st = getStatusChecked(p);
    if (st === null) return null;
    n += st.split('\n').filter((l) => l.trim()).length;
  }
  return n;
}

/** The real inputs of forkSession; `summarize` and `uncommitted` come from the server (catch-up, diff stats). */
export function defaultForkDeps(
  opts: Pick<ForkDeps, 'summarize' | 'uncommitted'> & Partial<ForkDeps> & { create?: CreateWorktree },
): ForkDeps {
  return {
    config: loadConfig,
    repos: (target, config, parent) => {
      const t = resolveProjectTarget(target, config);
      if (!t) return null;
      // A group session's own repos (recorded; a row from before: the group's config).
      const aliases = parent && t.isGroup ? sessionAliases(parent, config) : t.repoAliases;
      return aliases.flatMap((alias) => (config.repos[alias] ? [{ alias, repoPath: config.repos[alias] }] : []));
    },
    branchOf: checkedOutBranch,
    // Branches only (a tag or a short SHA of that name is no clash).
    branchExists: (repoPath, branch) =>
      ['refs/heads/', 'refs/remotes/origin/'].some(
        (prefix) => git(['show-ref', '--verify', '--quiet', `${prefix}${branch}`], repoPath).exitCode === 0,
      ),
    validBranch: (name) => !name.startsWith('-') && git(['check-ref-format', '--branch', name], os.tmpdir()).exitCode === 0,
    setup: async (target, branch, config, base, name) => {
      const made = await (opts.create ?? createInProcess)({ target, branch, base, name }, config);
      return made.ok ? { paths: made.paths } : { error: made.error };
    },
    start: startSessionWithPrompt,
    sessionIdFor,
    ...opts,
  };
}
