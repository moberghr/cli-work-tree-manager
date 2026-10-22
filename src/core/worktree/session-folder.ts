import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';

/**
 * Where a session folder (a group's, or a repo's made with `sessionFolders`)
 * lives. With `sessionFolders` on, a new one is
 * `<worktreesRoot>/<branch-dir>-<id6>/<repo-folder>/`: named by its branch,
 * the session's own id (`sessionIdFor`, its first six characters) keeping two
 * sessions of one branch name — in two projects — apart. The id is fixed for
 * the session, so a Restore puts it back in the same folder (where Claude Code
 * finds its conversation), and it can be worked out from the session alone.
 * Otherwise, and for every session made before, `<worktreesRoot>/<target>/<branch-dir>/`,
 * as it always was. Pure.
 */

const ID_CHARS = 6;

/** `fix/login` of project `shop` → `fix-login-a3f9c2`. */
export function flatFolderName(target: string, branch: string): string {
  return `${branch.replace(/\//g, '-')}-${sessionIdFor({ target, branch }).slice(0, ID_CHARS)}`;
}

/**
 * The session folder for target + branch. An existing session keeps the
 * layout it was made with (its recorded folder says which); a new one gets
 * the flat layout when config `sessionFolders` is on.
 */
export function sessionFolderPath(
  target: string,
  branch: string,
  config: Pick<WorkConfig, 'worktreesRoot' | 'sessionFolders'>,
  known?: Pick<WorktreeSession, 'paths'> | null,
): string {
  const flat = path.join(config.worktreesRoot, flatFolderName(target, branch));
  const old = path.join(config.worktreesRoot, target, branch.replace(/\//g, '-'));
  if (known) {
    const recorded = known.paths[0] ? path.basename(path.dirname(known.paths[0])) : '';
    return recorded.toLowerCase() === flatFolderName(target, branch).toLowerCase() ? flat : old;
  }
  return config.sessionFolders === true ? flat : old;
}

/**
 * The project a flat session folder belongs to (rebuilding sessions from the
 * worktrees on disk): the repo alias or group whose session of this branch has
 * this folder's name. Undefined when none does — not a flat folder, or its
 * worktree has since moved to another branch.
 */
export function flatFolderOwner(folder: string, branch: string, config: Pick<WorkConfig, 'repos' | 'groups'>): string | undefined {
  const name = folder.toLowerCase();
  return [...Object.keys(config.groups ?? {}), ...Object.keys(config.repos ?? {})].find(
    (target) => flatFolderName(target, branch).toLowerCase() === name,
  );
}
