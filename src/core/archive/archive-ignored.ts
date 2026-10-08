import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git/git.js';
import { BUILD_DIR_NAMES } from '../cleanup/build-folders.js';
import type { SavedIgnored } from './session-archive.js';

/**
 * A worktree's git-ignored files that aren't build output — local settings
 * (`appsettings.Development.json`, `.env.local`), the editor's state (`.vs`,
 * `.idea`) — kept when archiving removes the worktree and put back on
 * Restore, so it comes back as it was. The uncommitted save
 * (archive-uncommitted.ts) leaves them out; build output stays out here too
 * (a build makes it again). Copied as files into the archive folder
 * (`ignored/<repo>/…`), within caps: a stray dump shouldn't land in ~/.work.
 */

/** A bigger file isn't kept (an IDE's index, a database dump). */
export const MAX_IGNORED_FILE_BYTES = 5 * 1024 * 1024;
/** Nor more than this in all, per repo. */
export const MAX_IGNORED_TOTAL_BYTES = 50 * 1024 * 1024;

export type { SavedIgnored };

/** A path inside build output (any folder of it named as one: bin, obj, node_modules…). */
const inBuildOutput = (rel: string): boolean => rel.split(/[\\/]/).some((seg) => seg === '.git' || BUILD_DIR_NAMES.has(seg));

/** The ignored files under a worktree, relative (folders git lists whole are walked), build output left out. */
export function ignoredFiles(worktree: string): string[] {
  const r = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], worktree);
  if (r.exitCode !== 0) return [];
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r2 = path.join(rel, e.name);
      if (inBuildOutput(r2)) continue;
      if (e.isDirectory()) walk(r2);
      else if (e.isFile()) out.push(r2);
    }
  };
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const rel = entry.replace(/\/$/, '');
    if (inBuildOutput(rel)) continue;
    if (entry.endsWith('/')) walk(rel);
    else out.push(rel);
  }
  return out;
}

/** Copy a worktree's ignored files (not build output, within the caps) into `dest`. */
export function saveIgnored(
  worktree: string,
  dest: string,
  caps = { file: MAX_IGNORED_FILE_BYTES, total: MAX_IGNORED_TOTAL_BYTES },
): SavedIgnored {
  const saved: SavedIgnored = { files: 0, bytes: 0, skipped: 0 };
  for (const rel of ignoredFiles(worktree)) {
    const from = path.join(worktree, rel);
    let size: number;
    try {
      size = fs.statSync(from).size;
    } catch {
      continue;
    }
    if (size > caps.file || saved.bytes + size > caps.total) {
      saved.skipped++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(dest, rel));
      saved.files++;
      saved.bytes += size;
    } catch {
      saved.skipped++;
    }
  }
  return saved;
}

/** Put saved ignored files back into a worktree: the archived ones win (they were the worktree's own). Returns how many. */
export function restoreIgnored(src: string, worktree: string): number {
  let n = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        fs.mkdirSync(path.dirname(path.join(worktree, r)), { recursive: true });
        fs.copyFileSync(path.join(src, r), path.join(worktree, r));
        n++;
      }
    }
  };
  if (fs.existsSync(src)) walk('');
  return n;
}
