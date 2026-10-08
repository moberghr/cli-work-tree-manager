import fs from 'node:fs';
import path from 'node:path';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import { isBuildOutputPath } from '../cleanup/build-folders.js';
import type { SavedIgnored } from './session-archive.js';

/**
 * A worktree's git-ignored files that aren't build output — local settings
 * (`appsettings.Development.json`, `.env.local`), the editor's state (`.vs`,
 * `.idea`) — kept when archiving removes the worktree and put back on
 * Restore, so it comes back as it was. The uncommitted save
 * (archive-uncommitted.ts) leaves them out; build output, environments and
 * package caches stay out here too (they're made again). Copied as files
 * into the archive folder (`ignored/<repo>/…`), within caps: a stray dump
 * shouldn't land in ~/.work. They can hold secrets: `work move export`
 * leaves them behind, and archive retention deletes them after
 * `compressAfterDays` (archive-retention.ts).
 */

export type { SavedIgnored };

/** A bigger file isn't kept (an IDE's index, a database dump). */
export const MAX_IGNORED_FILE_BYTES = 5 * 1024 * 1024;
/** Nor more than this in all, per repo. */
export const MAX_IGNORED_TOTAL_BYTES = 50 * 1024 * 1024;
/** Nor more files than this are looked at: a big ignored tree isn't walked to its end (archiving runs in work web). */
export const MAX_IGNORED_FILES = 5000;

/** Ignored folders that are neither settings nor editor state: environments and package caches. */
const HEAVY = new Set([
  '.venv',
  'venv',
  'packages',
  '.pnpm-store',
  '.yarn',
  '.cache',
  '.terraform',
  '.tox',
  '.mypy_cache',
  '.ruff_cache',
  '.dart_tool',
]);
const leftOut = (rel: string): boolean => isBuildOutputPath(rel) || rel.split(/[\\/]/).some((seg) => HEAVY.has(seg));

/**
 * The ignored files under a worktree, relative (folders git lists whole are
 * walked), build output and heavy folders left out; at most `max`, `more`
 * when it stopped there. Off the event loop: git and the walk are async.
 */
export async function ignoredFiles(worktree: string, max = MAX_IGNORED_FILES): Promise<{ files: string[]; more: boolean }> {
  const r = await runGitAsync(worktree, { args: ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'] });
  if (r.status !== 0) return { files: [], more: false };
  const files: string[] = [];
  let more = false;
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(worktree, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= max) {
        more = true;
        return;
      }
      const r2 = path.join(rel, e.name);
      if (leftOut(r2)) continue;
      if (e.isDirectory()) await walk(r2);
      else if (e.isFile()) files.push(r2);
    }
  };
  const entries = r.stdout.split('\0').filter(Boolean);
  // git lists a folder whole when it's ignored, but also an untracked folder that holds ignored
  // files (and those files again): only the ignored folders are walked.
  const dirs = entries.filter((e) => e.endsWith('/') && !leftOut(e.replace(/\/$/, '')));
  const ignoredDirs = new Set<string>();
  if (dirs.length) {
    const check = await runGitAsync(worktree, { args: ['check-ignore', '--', ...dirs] });
    for (const d of check.stdout.split(/\r?\n/).filter(Boolean)) ignoredDirs.add(d.replace(/\/$/, ''));
  }
  for (const entry of entries) {
    if (files.length >= max) {
      more = true;
      break;
    }
    const rel = entry.replace(/\/$/, '');
    if (leftOut(rel)) continue;
    if (!entry.endsWith('/')) files.push(path.normalize(rel));
    else if (ignoredDirs.has(rel)) await walk(path.normalize(rel));
  }
  return { files: [...new Set(files)], more };
}

/**
 * Copy a worktree's ignored files (not build output, within the caps) into
 * `dest`, the smallest first: settings files are small, an editor's index is
 * not, and it mustn't use up the budget before them.
 */
export async function saveIgnored(
  worktree: string,
  dest: string,
  caps = { file: MAX_IGNORED_FILE_BYTES, total: MAX_IGNORED_TOTAL_BYTES, files: MAX_IGNORED_FILES },
): Promise<SavedIgnored> {
  const saved: SavedIgnored = { files: 0, bytes: 0, skipped: 0 };
  const listed = await ignoredFiles(worktree, caps.files);
  if (listed.more) saved.partial = true;
  const sized: Array<{ rel: string; size: number }> = [];
  for (const rel of listed.files) {
    try {
      sized.push({ rel, size: (await fs.promises.stat(path.join(worktree, rel))).size });
    } catch {
      /* gone meanwhile */
    }
  }
  sized.sort((a, b) => a.size - b.size || a.rel.localeCompare(b.rel));
  for (const { rel, size } of sized) {
    if (size > caps.file || saved.bytes + size > caps.total) {
      saved.skipped++;
      continue;
    }
    try {
      await fs.promises.mkdir(path.dirname(path.join(dest, rel)), { recursive: true });
      await fs.promises.copyFile(path.join(worktree, rel), path.join(dest, rel));
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
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.cpSync(src, worktree, {
    recursive: true,
    force: true,
    filter: (from) => {
      if (fs.statSync(from).isFile()) n++;
      return true;
    },
  });
  return n;
}
