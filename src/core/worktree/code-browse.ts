import fs from 'node:fs';
import path from 'node:path';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import type { WorktreeSession } from '../sessions/history.js';
import type { CodeFileWire, CodeFilesWire, CodeRepoWire } from '../api-types.js';

/**
 * The Code tab: a session's files, to read the rest of the code around a
 * change. Read only — Claude edits these files, and two writers lose work.
 *
 * What it lists is what git does: tracked files and new ones that aren't
 * ignored (`git ls-files -co --exclude-standard`), so no node_modules, bin,
 * obj. A file is read only when that list has it: nothing outside the
 * worktree (no `..`, no links out), nothing git ignores (`.env`, local
 * settings). Everything runs git off the event loop.
 */

/** More than this many files in one repo: the rest aren't listed (the tree would be unusable anyway). */
export const MAX_CODE_FILES = 50_000;
/** Bigger than this: not shown as text. */
export const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;
/** A list is read again after this long (a burst of requests shares one git run). */
const LIST_TTL_MS = 3000;

export interface CodeRoot {
  /** Its folder name: what the SPA calls the repo. */
  name: string;
  root: string;
}

/** The session's repos, each by its folder's name. */
export function codeRoots(s: Pick<WorktreeSession, 'paths'>): CodeRoot[] {
  return s.paths.map((p) => ({ name: path.basename(p), root: p }));
}

/** A group's own folder (where its repos are), or null for a single repo. */
export function groupRoot(s: Pick<WorktreeSession, 'paths' | 'isGroup'>): string | null {
  if (!s.isGroup || s.paths.length === 0) return null;
  const parents = [...new Set(s.paths.map((p) => path.dirname(p)))];
  return parents.length === 1 ? parents[0] : null;
}

export interface CodeIo {
  git: (cwd: string, args: string[]) => Promise<{ status: number | null; stdout: string }>;
}

const realIo: CodeIo = {
  git: (cwd, args) => runGitAsync(cwd, { args }),
};

const nul = (out: string) => out.split('\0').filter(Boolean);
const fwd = (p: string) => p.replace(/\\/g, '/');

const listCache = new Map<string, { at: number; files: Promise<string[]> }>();

/** `git ls-files -co --exclude-standard`: tracked, and new but not ignored. Shared for LIST_TTL_MS. */
export function listRepoFiles(root: string, io: CodeIo = realIo, now = Date.now()): Promise<string[]> {
  const hit = listCache.get(root);
  if (hit && now - hit.at < LIST_TTL_MS) return hit.files;
  const files = io.git(root, ['ls-files', '-co', '--exclude-standard', '-z']).then((r) => {
    if (r.status !== 0) return [];
    return [...new Set(nul(r.stdout).map(fwd))].sort();
  });
  listCache.set(root, { at: now, files });
  return files;
}

/** Changed on this branch: not committed (incl. new files), or committed since it left `base` (else origin/HEAD). */
export async function changedFiles(root: string, base: string | undefined, io: CodeIo = realIo): Promise<string[]> {
  const out = new Set<string>();
  const status = await io.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.status === 0) {
    const entries = nul(status.stdout);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const code = e.slice(0, 2);
      out.add(fwd(e.slice(3)));
      if (code.includes('R') || code.includes('C')) i++; // a rename's old path follows it
    }
  }
  for (const ref of base ? [base, `origin/${base}`] : ['origin/HEAD']) {
    const mb = await io.git(root, ['merge-base', ref, 'HEAD']);
    const sha = mb.stdout.trim();
    if (mb.status !== 0 || !sha) continue;
    const diff = await io.git(root, ['diff', '--name-only', '-z', `${sha}...HEAD`]);
    if (diff.status === 0) for (const f of nul(diff.stdout)) out.add(fwd(f));
    break;
  }
  return [...out].sort();
}

/** Every repo's files, the changed ones, and a group folder's own files. */
export async function listCodeFiles(
  s: Pick<WorktreeSession, 'paths' | 'isGroup' | 'baseBranch' | 'baseBranches'>,
  io: CodeIo = realIo,
): Promise<CodeFilesWire> {
  const repos: CodeRepoWire[] = await Promise.all(
    codeRoots(s).map(async ({ name, root }) => {
      if (!fs.existsSync(root)) return { name, files: [], changed: [], truncated: false };
      const [all, changed] = await Promise.all([listRepoFiles(root, io), changedFiles(root, s.baseBranches?.[root] ?? s.baseBranch, io)]);
      const listed = new Set(all);
      return {
        name,
        files: all.slice(0, MAX_CODE_FILES),
        changed: changed.filter((f) => listed.has(f)),
        truncated: all.length > MAX_CODE_FILES,
      };
    }),
  );
  return { group: !!s.isGroup, rootFiles: groupRootFiles(s), repos };
}

/** A group folder's own files (its CLAUDE.md…), not its repos' folders. */
function groupRootFiles(s: Pick<WorktreeSession, 'paths' | 'isGroup'>): string[] {
  const dir = groupRoot(s);
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export type CodeReadError = 'unknown repo' | 'not listed' | 'unreadable';

/**
 * One file as it is now. `repo` '' is a group folder's own file. Only a file the listing has (so nothing outside
 * the worktree and nothing git ignores), and only a regular file whose real path is still inside it (a link out
 * is refused).
 */
export async function readCodeFile(
  s: Pick<WorktreeSession, 'paths' | 'isGroup'>,
  repo: string,
  rel: string,
  io: CodeIo = realIo,
): Promise<CodeFileWire | { error: CodeReadError }> {
  let root: string | null;
  let allowed: boolean;
  if (repo === '') {
    root = groupRoot(s);
    allowed = !!root && groupRootFiles(s).includes(rel);
  } else {
    root = codeRoots(s).find((r) => r.name === repo)?.root ?? null;
    allowed = !!root && (await listRepoFiles(root, io)).includes(rel);
  }
  if (!root) return { error: 'unknown repo' };
  if (!allowed) return { error: 'not listed' };
  try {
    const full = path.resolve(root, rel);
    const realRoot = fs.realpathSync.native(root);
    const real = fs.realpathSync.native(full);
    const inside = path.relative(realRoot, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { error: 'not listed' };
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: 'unreadable' };
    if (st.size > MAX_CODE_FILE_BYTES) return { repo, path: rel, size: st.size, text: null, reason: 'too-large' };
    const buf = await fs.promises.readFile(real);
    if (buf.subarray(0, 8000).includes(0)) return { repo, path: rel, size: st.size, text: null, reason: 'binary' };
    return { repo, path: rel, size: st.size, text: buf.toString('utf-8') };
  } catch {
    return { error: 'unreadable' };
  }
}

/** Tests: forget the shared lists. */
export function clearCodeListCache(): void {
  listCache.clear();
}
