/**
 * The rules for enrolling repos and making groups (repo-admin.ts, the Repos
 * page, the demo): what alias a repo gets, and why one can't be used. Pure,
 * without node:path — the demo and the SPA import it.
 */

/** A path's last part. */
const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;
/** Its folder. */
const dirName = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');

/** A resolved path written one way, for comparing: `/`, no trailing separator, lowercase when `caseless` (Windows). */
export function pathKey(resolved: string, caseless: boolean): string {
  const r = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseless ? r.toLowerCase() : r;
}

/** Two paths as the same folder: separators, a trailing one and (with a drive letter) case don't matter. */
const sameFolder = (a: string, b: string) => {
  const caseless = /^[a-z]:/i.test(a) || /^[a-z]:/i.test(b);
  return pathKey(a, caseless) === pathKey(b, caseless);
};

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A folder name as an alias: lowercase, only a-z 0-9 . _ - . Pure. */
export function aliasFromFolder(folder: string): string {
  return (
    folder
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '') || 'repo'
  );
}

/**
 * The alias a found repo would get: its folder's, or — taken by an alias
 * or a group — its parent folder's in front (`iom-contracts`), then -2, -3….
 * Pure.
 */
export function suggestAlias(repoPath: string, taken: (alias: string) => boolean): string {
  const base = aliasFromFolder(baseName(repoPath));
  if (!taken(base)) return base;
  const withParent = `${aliasFromFolder(baseName(dirName(repoPath)))}-${base}`;
  if (!taken(withParent)) return withParent;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Why a repo can't be enrolled under `alias`; null when it can. Besides the
 * alias itself (its characters, an alias or group of that name), the
 * folder: worktrees go in `<worktreesRoot>/<folder>/`, so two repos with the
 * same folder name would share them. Pure.
 */
export function enrollProblem(
  alias: string,
  repoPath: string,
  config: { repos: Record<string, string>; groups: Record<string, string[]> },
): string | null {
  if (!ALIAS_RE.test(alias)) return 'an alias is lowercase letters, digits, . _ - (starting with a letter or digit)';
  if (alias in config.repos) return `“${alias}” is already the alias of ${config.repos[alias]}`;
  if (alias in config.groups) return `“${alias}” is a group`;
  const same = Object.entries(config.repos).find(([, p]) => sameFolder(p, repoPath));
  if (same) return `already enrolled as “${same[0]}”`;
  const folder = baseName(repoPath).toLowerCase();
  const clash = Object.entries(config.repos).find(([, p]) => baseName(p).toLowerCase() === folder);
  if (clash) return `another repo has the folder name “${baseName(repoPath)}” (${clash[0]}): their worktrees would share a folder`;
  if (Object.keys(config.groups).some((g) => g.toLowerCase() === folder))
    return `a group is called “${folder}”: its worktrees would share a folder`;
  return null;
}

/** Why a group can't be called `name`, or made of `members`; null when it can. Pure. */
export function groupProblem(
  name: string,
  members: string[],
  config: { repos: Record<string, string>; groups: Record<string, string[]> },
  opts: { creating: boolean },
): string | null {
  // The name is checked when it is given; an existing group keeps the one it has.
  if (opts.creating) {
    if (!ALIAS_RE.test(name)) return 'a group name is lowercase letters, digits, . _ - (starting with a letter or digit)';
    if (name in config.groups) return `a group “${name}” already exists`;
    if (name in config.repos) return `“${name}” is a repo's alias`;
    if (Object.values(config.repos).some((p) => baseName(p).toLowerCase() === name)) return `a repo's folder is called “${name}”`;
  } else if (!(name in config.groups)) {
    return `no group “${name}”`;
  }
  if (new Set(members).size < 2) return 'a group needs at least two repos';
  const unknown = members.filter((m) => !(m in config.repos));
  if (unknown.length) return `not enrolled: ${unknown.join(', ')}`;
  return null;
}
