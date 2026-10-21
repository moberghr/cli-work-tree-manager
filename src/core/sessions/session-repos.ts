import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import type { WorktreeSession } from './session-types.js';

/**
 * A session's repos: which repo alias each of its folders is a checkout of.
 * The session owns that list (`WorktreeSession.repos`, recorded when it is
 * made), so a session can hold a repo its group's config doesn't name, and
 * keep one its group lost. Rows from before it was recorded are read as they
 * always were: a group's from the config, a single repo's by its target.
 * Pure: the config is passed in.
 */

type SessionShape = Pick<WorktreeSession, 'target' | 'isGroup' | 'paths' | 'repos'>;

export interface SessionRepo {
  alias: string;
  path: string;
  /** Legacy only: no repo of the group's config has this folder's name, so the
   *  alias is just the folder's name (readers that used to find no repo there skip it). */
  guessed?: true;
}

/** Its recorded list, zipped with its paths — null on a row from before (or one whose list doesn't match its paths). */
export function recordedRepos(s: Pick<WorktreeSession, 'paths' | 'repos'>): SessionRepo[] | null {
  if (!Array.isArray(s.repos) || s.repos.length !== s.paths.length || s.repos.length === 0) return null;
  if (!s.repos.every((a) => typeof a === 'string' && a)) return null;
  return s.repos.map((alias, i) => ({ alias, path: s.paths[i] }));
}

const sameName = (a: string, b: string) => path.basename(a).toLowerCase() === path.basename(b).toLowerCase();

/**
 * Each of its folders with the repo it is a checkout of. Recorded: as
 * recorded. Legacy: a group's folder is named after its repo's folder, so
 * the group's member (config) with that folder name, else the folder's own
 * name (`guessed`); a single repo's is its target.
 */
export function sessionRepos(s: SessionShape, config: Partial<Pick<WorkConfig, 'repos' | 'groups'>> | null | undefined): SessionRepo[] {
  const recorded = recordedRepos(s);
  if (recorded) return recorded;
  if (!s.isGroup) return s.paths.length ? [{ alias: s.target, path: s.paths[0] }] : [];
  // A list that is there but doesn't match its paths (a damaged row): each folder is matched
  // by name among the recorded aliases first — never read as a row from before, whose group
  // config may name none of them (a repo's session folder has no group at all).
  const listed = Array.isArray(s.repos) ? s.repos.filter((a): a is string => typeof a === 'string' && !!a) : [];
  const members = [...new Set([...listed, ...(config?.groups?.[s.target] ?? [])])];
  return s.paths.map((p) => {
    const alias = members.find((a) => {
      const repo = config?.repos?.[a];
      return repo !== undefined && sameName(repo, p);
    });
    return alias ? { alias, path: p } : { alias: path.basename(p), path: p, guessed: true as const };
  });
}

/**
 * The repo aliases a session acts over (archive, clean-up, checkpoints…).
 * Recorded: its own. Legacy, as before: a group's config members, a single
 * repo's target.
 */
export function sessionAliases(s: SessionShape, config: Partial<Pick<WorkConfig, 'repos' | 'groups'>> | null | undefined): string[] {
  const recorded = recordedRepos(s);
  if (recorded) return recorded.map((r) => r.alias);
  // A damaged list: what its folders are matched to, never the group's config alone.
  // (Without the repos' folders to match by, what it lists.)
  if (Array.isArray(s.repos) && s.isGroup)
    return config?.repos
      ? sessionRepos(s, config)
          .filter((r) => !r.guessed)
          .map((r) => r.alias)
      : s.repos.filter((a): a is string => typeof a === 'string' && !!a);
  return s.isGroup ? (config?.groups?.[s.target] ?? []) : [s.target];
}

/**
 * A session that is a folder of repos (a group's, or a repo's made with
 * `sessionFolders`): Claude runs in the folder, and a repo can be added to it.
 */
export function isFolderSession(s: Pick<WorktreeSession, 'isGroup'>): boolean {
  return s.isGroup;
}
