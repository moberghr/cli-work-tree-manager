import type { SessionSummary } from '../api/client.js';
import type { AddRepoWire } from '../../../core/api-types.js';

/**
 * Add a repo… (AddRepoDialog): which repos can be added to a session folder,
 * the repos the header shows, and what the toast says. Pure.
 */

/** A repo can be added: a session folder (a group's, or one made with `sessionFolders`), not archived.
 *  A row from a server before `folder` has none: no Add a repo (that server has no route for it either). */
export function canAddRepo(s: Pick<SessionSummary, 'folder' | 'archivedAt'>): boolean {
  return s.folder === true && !s.archivedAt;
}

/** The enrolled repos not in the session yet, in the order they came. */
export function addableRepos(all: readonly string[], inSession: readonly string[]): string[] {
  const taken = new Set(inSession.map((a) => a.toLowerCase()));
  return all.filter((a) => !taken.has(a.toLowerCase()));
}

const baseName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;

/** A session folder's repos, for its header: the recorded aliases, else (a server before
 *  `repos`) its folders' names. A single repo's session: none (its target says it). */
export function headerRepos(s: Pick<SessionSummary, 'folder' | 'isGroup' | 'repos' | 'paths'>): string[] {
  if (!(s.folder ?? s.isGroup)) return [];
  return s.repos?.length ? s.repos : s.paths.map(baseName);
}

/** "Added docs: ./straumur-documentation on feat/x" (made from main, when its branch is new). */
export function addedRepoText(alias: string, w: Pick<AddRepoWire, 'path' | 'branch' | 'created' | 'from'>): string {
  const made = w.created && w.from ? `, made from ${w.from}` : '';
  return `Added ${alias}: ./${baseName(w.path)} on ${w.branch}${made}`;
}
