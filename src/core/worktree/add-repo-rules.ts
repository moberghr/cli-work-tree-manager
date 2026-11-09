import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { isFolderSession, sessionRepos } from '../sessions/session-repos.js';
import type { WorktreeSession } from '../sessions/session-types.js';

/**
 * Add a repo's rules, pure (no git, no state): which adds are refused, and
 * the note its Claude gets. Shared by add-repo.ts, its route, `work add-repo`
 * and the demo, so they answer the same.
 */

/** Why a repo can't be added, and the HTTP status that says it (404 no session, 400 a bad request, 409 not now / not here). */
export interface AddRepoRefusal {
  status: 400 | 404 | 409;
  error: string;
}

const sameFolder = (a: string, b: string) => path.basename(a).toLowerCase() === path.basename(b).toLowerCase();

export const NOT_A_FOLDER =
  "is a single repo's worktree, not a session folder: a repo can only be added to a session made as a folder (a group's, or a new session with config `sessionFolders: true`)";

/**
 * Why this repo can't be added to this session, or null. Pure apart from the
 * one look at the disk (`exists`): a folder of that name in the session folder.
 */
export function addRepoRefusal(
  s: Pick<WorktreeSession, 'target' | 'branch' | 'isGroup' | 'paths' | 'repos' | 'archivedAt'> | null,
  alias: string,
  config: Pick<WorkConfig, 'repos' | 'groups'>,
  exists: (p: string) => boolean,
  base?: string,
): AddRepoRefusal | null {
  if (!s) return { status: 404, error: 'unknown session' };
  if (!alias || alias.startsWith('-') || base?.startsWith('-'))
    return { status: 400, error: `not a valid repo or base: ${alias}${base ? ` ${base}` : ''}` };
  if (s.archivedAt) return { status: 409, error: 'it is archived: restore it first' };
  if (!isFolderSession(s) || s.paths.length === 0) return { status: 409, error: `${s.target} · ${s.branch} ${NOT_A_FOLDER}` };
  const repoPath = config.repos[alias];
  if (!repoPath) return { status: 400, error: `no repo called ${alias} in your config` };
  const own = sessionRepos(s, config);
  // A session from before whose folder matches no repo of its group: recording its list would
  // make that folder's name an alias — and teardown would ask the wrong repo to remove it.
  const unknown = own.filter((r) => r.guessed).map((r) => path.basename(r.path));
  if (unknown.length)
    return { status: 409, error: `no repo of ${s.target} is in its folder ${unknown.join(', ')}: add that repo back to the group first` };
  if (own.some((r) => r.alias === alias)) return { status: 409, error: `${alias} is in this session already` };
  const folder = path.basename(repoPath);
  if (s.paths.some((p) => sameFolder(p, folder))) return { status: 409, error: `this session already has a folder called ${folder}` };
  if (exists(path.join(path.dirname(s.paths[0]), folder)))
    return { status: 409, error: `${folder} already exists in the session folder: move it away first` };
  return null;
}

/**
 * The note the session's Claude gets once a repo was added (a published
 * general comment). Pure. `imported`: the folder's instructions file imports
 * the repo's own now (false: it has none, or its agent can't import).
 */
export function addedRepoNote(
  r: { alias: string; path: string; branch: string; from?: string; imported?: boolean },
  instructionsFile = 'CLAUDE.md',
): string {
  const folder = path.basename(r.path);
  return (
    `Added repo ${r.alias} to this session: ./${folder} on branch ${r.branch}${r.from ? `, made from ${r.from}` : ''}. ` +
    (r.imported
      ? `Its ${instructionsFile} is imported by the session's instructions file.`
      : `Read its own instructions (./${folder}/${instructionsFile}, if it has one) before working in it.`)
  );
}
