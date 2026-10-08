import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIR_NAMES } from '../cleanup/build-folders.js';
import { pathKey } from './repo-rules.js';
export { aliasFromFolder, enrollProblem, groupProblem, suggestAlias } from './repo-rules.js';

/**
 * Finding the git repos in a folder (the Repos page, `work config scan`):
 * a breadth-first walk, a few levels deep, that stops at each repo it finds
 * (a repo inside a repo is that repo's business), and skips what is never a
 * project of its own — build output, dot-folders, work's worktrees, a
 * worktree's or a submodule's `.git` file. Reads only: directory listings
 * and the `.git` entries.
 */

export interface FoundRepo {
  /** As found on disk. */
  path: string;
  /** Its folder name. */
  folder: string;
  /** `owner/name` from its origin URL, when it has one. */
  origin: string | null;
}

/** One way to write a path, for comparing: resolved, no trailing separator, `/`, lowercase on Windows. Pure. */
export function samePathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return pathKey(path.resolve(p), platform === 'win32');
}

/** `owner/name` from an origin URL (https or ssh, with or without .git); null when it isn't one. Pure. */
export function ownerRepo(url: string): string | null {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The origin URL in a `.git/config` text. Pure. */
export function originUrl(configText: string): string | null {
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(configText);
  const url = section ? /^\s*url\s*=\s*(.+)$/m.exec(section[1]) : null;
  if (!url) return null;
  // As git writes a value: maybe quoted, with \\ and \" escaped (a Windows path).
  const v = url[1].trim().replace(/^"(.*)"$/, '$1');
  return v.replace(/\\(["\\])/g, '$1');
}

/**
 * A repo's git config text, or null: `.git/config`, or for a folder whose
 * `.git` is a file (a linked worktree, a submodule) the config of the repo
 * it points into (`gitdir:`, then its `commondir`).
 */
export function readGitConfig(repoPath: string): string | null {
  const g = path.join(repoPath, '.git');
  try {
    if (fs.statSync(g).isDirectory()) return fs.readFileSync(path.join(g, 'config'), 'utf-8');
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf-8'))?.[1].trim();
    if (!gitdir) return null;
    const dir = path.resolve(repoPath, gitdir);
    let common = dir;
    try {
      common = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf-8').trim());
    } catch {
      /* a submodule's gitdir holds its own config */
    }
    return fs.readFileSync(path.join(common, 'config'), 'utf-8');
  } catch {
    return null;
  }
}

/** What a folder's `.git` says it is: a repo, a linked worktree or a submodule (a `.git` file), or nothing. */
function gitKind(dir: string): 'repo' | 'linked' | null {
  const g = path.join(dir, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(g);
  } catch {
    return null;
  }
  if (st.isDirectory()) return 'repo';
  // A file: `gitdir: …/.git/worktrees/x` (a worktree) or `…/.git/modules/x` (a submodule) — part of another repo.
  return 'linked';
}

function readOrigin(dir: string): string | null {
  const url = originUrl(readGitConfig(dir) ?? '');
  return url ? ownerRepo(url) : null;
}

/**
 * The git repos under `root`, at most `depth` folders down (1 = its
 * children). `skip`: folders never walked into (work's worktrees root),
 * compared with samePathKey. A root that doesn't exist gives none.
 */
export function scanForRepos(root: string, opts: { depth?: number; skip?: string[] } = {}): FoundRepo[] {
  const depth = opts.depth ?? 2;
  const skip = new Set((opts.skip ?? []).filter(Boolean).map((p) => samePathKey(p)));
  const found: FoundRepo[] = [];
  let level: string[] = [root];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level) {
      if (skip.has(samePathKey(dir))) continue;
      const kind = d === 0 ? null : gitKind(dir);
      if (kind === 'repo') {
        found.push({ path: dir, folder: path.basename(dir), origin: readOrigin(dir) });
        continue; // a repo's insides are its own
      }
      if (kind === 'linked') continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || BUILD_DIR_NAMES.has(e.name.toLowerCase())) continue;
        next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return found.sort((a, b) => a.folder.localeCompare(b.folder));
}
