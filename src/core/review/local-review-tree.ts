import path from 'node:path';

/**
 * A session's own review read in the session's folder (reported: half its notes asked "please confirm how X works",
 * because the AI step saw the diff alone, and the answer was in the repo). The agent's read-only run — file reads
 * confined to the folder, nothing that runs, writes or fetches, none of the folder's settings, hooks or MCP servers —
 * is started in the folder the changes are being made in, so it can read the callers and the code around a change.
 *
 * Unlike a PR's temporary checkout (review-tree.ts), this is YOUR folder: nothing in it is deleted or changed, and
 * the files your repos' own settings forbid reading (`permissions.deny`, e.g. a production settings file) are
 * forbidden to this run too (`denyRules`), since it doesn't load those settings itself.
 */

/** Where a review of these repos is read: the folder to start in, and each repo's folder with its place under it. */
export interface SessionTree {
  cwd: string;
  /** `sub`: the repo's folder name under `cwd` (the start of its paths in the review); null: it is `cwd` itself. */
  repos: Array<{ dir: string; sub: string | null }>;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The folder a review of `names` (the repos' folder names, as the session's diff names them) is read in. One repo:
 * its own folder, its paths as they are. Several: the folder that holds them all, when each path of the review
 * (`<name>/…`) is then a real path under it — the session folder of a group. Null when there is no such folder (two
 * repos with one name, or repos that don't share a parent): the review reads the diff alone. Pure.
 */
export function sessionTree(paths: readonly string[], names: readonly string[]): SessionTree | null {
  const byName = new Map<string, string[]>();
  for (const p of paths) byName.set(path.basename(norm(p)), [...(byName.get(path.basename(norm(p))) ?? []), norm(p)]);
  const dirs = names.map((n) => byName.get(n));
  if (names.length === 0 || dirs.some((d) => !d || d.length !== 1)) return null;
  const found = dirs.map((d) => d![0]);
  if (names.length === 1) return { cwd: found[0], repos: [{ dir: found[0], sub: null }] };
  const parent = path.posix.dirname(found[0]);
  if (found.some((d) => path.posix.dirname(d) !== parent)) return null;
  return { cwd: parent, repos: found.map((dir, i) => ({ dir, sub: names[i] })) };
}

/** How long one pass may read in the folder before it is given up (and asked again on the diff alone). */
export const LOCAL_TREE_TIMEOUT_MS = 420_000;

/** What the prompt says of several repos in one folder. */
export const SEVERAL_REPOS_LINE =
  "The folder holds several repos, each in the folder its paths start with: a file's path as listed is its path from where you are.";

export interface LocalTreeDeps {
  /** The agent's read-only run, or null when it has none. */
  readOnly: () => {
    localLines?: string[];
    denyRules?: (repos: SessionTree['repos']) => string[];
    available?: () => Promise<{ ok: boolean; why?: string }>;
  } | null;
  /** Run it in `cwd` with those files forbidden; null: no answer. */
  run: (prompt: string, cwd: string, deny: string[]) => Promise<string | null>;
  exists: (dir: string) => boolean;
}

/**
 * How a review of these repos can be read in the session's folder: the lines its prompt carries and the ask; or why
 * it can't (`why`), and the review reads the diff alone.
 */
export async function localTreeRun(
  paths: readonly string[],
  names: readonly string[],
  deps: LocalTreeDeps,
): Promise<{ lines: string[]; ask: (prompt: string) => Promise<string | null> } | { why: string }> {
  const mode = deps.readOnly();
  if (!mode?.localLines) return { why: 'the agent has no read-only mode' };
  const tree = sessionTree(paths, names);
  if (!tree) return { why: 'its repos are not in one folder' };
  if (!deps.exists(tree.cwd) || tree.repos.some((r) => !deps.exists(r.dir))) return { why: 'its folder is not there' };
  const can = await (mode.available?.() ?? Promise.resolve({ ok: true } as { ok: boolean; why?: string }));
  if (!can.ok) return { why: can.why ?? 'the read-only mode is not available' };
  const deny = mode.denyRules?.(tree.repos) ?? [];
  return {
    lines: [...mode.localLines, ...(tree.repos.length > 1 ? [SEVERAL_REPOS_LINE] : [])],
    ask: (prompt) => deps.run(prompt, tree.cwd, deny),
  };
}
