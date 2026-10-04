import fs from 'node:fs';
import path from 'node:path';
import type { GroupRow, RepoRow, ReposWire } from '../api-types.js';
import { getConfigDir, getConfigPath, type WorkConfig } from '../platform/config.js';
import { atomicWriteFile, withFileLock } from '../platform/fs-safe.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { enrollProblem, groupProblem, samePathKey, scanForRepos, suggestAlias, type FoundRepo } from './repo-scan.js';

/**
 * The Repos page's model and its changes (and `work config scan`'s): every
 * repo in the scanned folders — enrolled, new or ignored — plus the groups,
 * each with its live sessions; and enrolling, removing, ignoring, scanned
 * folders, groups. Changes edit config.json as it is on disk (its raw
 * JSON, so no setting this code doesn't know is lost) under the same lock
 * every writer of it takes.
 */

/** A refusal the user can act on (the route answers 400, or 409 when `sessions` could be forced past). */
export class RepoAdminError extends Error {
  constructor(
    message: string,
    readonly sessions: string[] = [],
  ) {
    super(message);
  }
}

/** The folders to scan: config `scanRoots`, else the one the worktrees root sits in. */
export function scanRootsOf(config: Pick<WorkConfig, 'scanRoots' | 'worktreesRoot'>): string[] {
  if (config.scanRoots?.length) return config.scanRoots;
  return config.worktreesRoot ? [path.dirname(config.worktreesRoot)] : [];
}

const live = (history: WorktreeSession[], target: string) => history.filter((s) => !s.archivedAt && s.target === target);
const label = (s: WorktreeSession) => `${s.target} · ${s.branch}`;

/**
 * Everything the Repos page shows. `found` defaults to scanning the roots
 * (two levels down, never into the worktrees root). Pure apart from that
 * scan and the existence check of enrolled folders.
 */
export function repoInventory(
  config: WorkConfig,
  history: WorktreeSession[],
  found: FoundRepo[] = scanRootsOf(config).flatMap((r) => scanForRepos(r, { skip: [config.worktreesRoot] })),
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): ReposWire {
  const byKey = new Map(found.map((f) => [samePathKey(f.path), f]));
  const ignored = new Set((config.ignoredRepos ?? []).map((p) => samePathKey(p)));
  const groupsOf = (alias: string) => Object.entries(config.groups).flatMap(([g, members]) => (members.includes(alias) ? [g] : []));
  const aliasesAt = new Map<string, string[]>();
  for (const [alias, p] of Object.entries(config.repos)) aliasesAt.set(samePathKey(p), [...(aliasesAt.get(samePathKey(p)) ?? []), alias]);

  const repos: RepoRow[] = Object.entries(config.repos).map(([alias, p]) => {
    const f = byKey.get(samePathKey(p));
    const others = (aliasesAt.get(samePathKey(p)) ?? []).filter((a) => a !== alias);
    return {
      path: p,
      folder: path.basename(p),
      origin: f?.origin ?? null,
      status: exists(p) ? 'enrolled' : 'missing',
      alias,
      ...(others.length ? { sharedWith: others } : {}),
      groups: groupsOf(alias),
      sessions: live(history, alias).length,
    };
  });
  const taken = (a: string) => a in config.repos || a in config.groups;
  for (const f of found) {
    const key = samePathKey(f.path);
    if (aliasesAt.has(key)) continue;
    if (ignored.has(key)) {
      repos.push({ path: f.path, folder: f.folder, origin: f.origin, status: 'ignored', alias: null, groups: [], sessions: 0 });
      continue;
    }
    const suggested = suggestAlias(f.path, taken);
    repos.push({
      path: f.path,
      folder: f.folder,
      origin: f.origin,
      status: 'new',
      alias: null,
      suggestedAlias: suggested,
      problem: enrollProblem(suggested, f.path, config),
      groups: [],
      sessions: 0,
    });
  }
  repos.sort((a, b) => a.folder.localeCompare(b.folder) || (a.alias ?? '').localeCompare(b.alias ?? ''));

  const groups: GroupRow[] = Object.entries(config.groups).map(([name, members]) => {
    const missing = members.filter((m) => !(m in config.repos));
    return {
      name,
      members,
      missing,
      sessions: live(history, name).length,
      problem: missing.length
        ? `not enrolled any more: ${missing.join(', ')}`
        : new Set(members).size < 2
          ? 'a group needs at least two repos'
          : null,
    };
  });
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { roots: scanRootsOf(config), repos, groups };
}

/** config.json as JSON, edited under its lock and written atomically; unknown keys kept. */
type RawConfig = Record<string, unknown> & { repos?: Record<string, string>; groups?: Record<string, string[]> };

async function editConfig<T>(fn: (raw: RawConfig) => T): Promise<T> {
  const file = getConfigPath();
  if (!fs.existsSync(file)) throw new RepoAdminError('No configuration yet: run `work init` first.');
  return withFileLock(file, () => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as RawConfig;
    raw.repos ??= {};
    raw.groups ??= {};
    const out = fn(raw);
    atomicWriteFile(file, JSON.stringify(raw, null, 2));
    return out;
  });
}

const view = (raw: RawConfig) => ({ repos: raw.repos ?? {}, groups: raw.groups ?? {} });

/** Enrol a repo under an alias: a git repo's own folder, the alias free, its folder name unshared. */
export async function enrollRepo(alias: string, repoPath: string): Promise<void> {
  const p = path.resolve(repoPath);
  if (!fs.existsSync(path.join(p, '.git'))) throw new RepoAdminError(`${p} is not the top folder of a git repository`);
  await editConfig((raw) => {
    const problem = enrollProblem(alias, p, view(raw));
    if (problem) throw new RepoAdminError(problem);
    raw.repos![alias] = p;
    const ignored = Array.isArray(raw.ignoredRepos) ? (raw.ignoredRepos as string[]) : [];
    raw.ignoredRepos = ignored.filter((x) => samePathKey(x) !== samePathKey(p));
  });
}

/**
 * Stop knowing a repo by this alias (the folder stays). Live sessions on
 * it would lose their project: refused unless `force`, naming them. It
 * also leaves every group it was in.
 */
export async function removeRepo(alias: string, history: WorktreeSession[], opts: { force?: boolean } = {}): Promise<void> {
  const sessions = live(history, alias);
  if (sessions.length && !opts.force)
    throw new RepoAdminError(`${sessions.length} live session${sessions.length === 1 ? '' : 's'} on ${alias}`, sessions.map(label));
  await editConfig((raw) => {
    if (!(alias in raw.repos!)) throw new RepoAdminError(`no repo “${alias}”`);
    delete raw.repos![alias];
    for (const [g, members] of Object.entries(raw.groups!)) raw.groups![g] = members.filter((m) => m !== alias);
  });
}

/** Ignore a found repo (the page stops offering it), or take that back. */
export async function setRepoIgnored(repoPath: string, ignored: boolean): Promise<void> {
  await editConfig((raw) => {
    const list = (Array.isArray(raw.ignoredRepos) ? (raw.ignoredRepos as string[]) : []).filter(
      (x) => samePathKey(x) !== samePathKey(repoPath),
    );
    raw.ignoredRepos = ignored ? [...list, path.resolve(repoPath)] : list;
  });
}

/** Add a folder to scan, or drop one. The first one added replaces the default. */
export async function setScanRoot(folder: string, on: boolean, config: Pick<WorkConfig, 'scanRoots' | 'worktreesRoot'>): Promise<void> {
  const p = path.resolve(folder);
  if (on && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new RepoAdminError(`${p} is not a folder`);
  await editConfig((raw) => {
    const current = scanRootsOf({ ...config, scanRoots: Array.isArray(raw.scanRoots) ? (raw.scanRoots as string[]) : config.scanRoots });
    const rest = current.filter((x) => samePathKey(x) !== samePathKey(p));
    raw.scanRoots = on ? [...rest, p] : rest;
  });
}

/**
 * Make a group, or change an existing one's repos. Its name is final
 * (sessions and worktree folders are named after it). A group's combined
 * instructions are written afterwards, by the caller (`regenerate`).
 */
export async function saveGroup(name: string, members: string[], opts: { creating: boolean }): Promise<void> {
  await editConfig((raw) => {
    const problem = groupProblem(name, members, view(raw), opts);
    if (problem) throw new RepoAdminError(problem);
    raw.groups![name] = [...new Set(members)];
  });
}

/** Delete a group (its repos stay). Live sessions on it are refused unless `force`; its combined instructions file goes. */
export async function deleteGroup(name: string, history: WorktreeSession[], opts: { force?: boolean } = {}): Promise<void> {
  const sessions = live(history, name);
  if (sessions.length && !opts.force)
    throw new RepoAdminError(`${sessions.length} live session${sessions.length === 1 ? '' : 's'} on ${name}`, sessions.map(label));
  await editConfig((raw) => {
    if (!(name in raw.groups!)) throw new RepoAdminError(`no group “${name}”`);
    delete raw.groups![name];
  });
  fs.rmSync(path.join(getConfigDir(), `${name}.claude.md`), { force: true });
}
