import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { isInsideRoot } from './diff-pipeline.js';

export interface ContextLinesOptions {
  /** Git toplevel (repo root) the file lives under. */
  root: string;
  /** Repo-relative path of the file. */
  relPath: string;
  /** 1-based inclusive first line to return. */
  start: number;
  /** 1-based inclusive last line to return. */
  end: number;
  /** When omitted or `'working'`, read the working-tree file. Otherwise the
   *  content comes from `git show <ref>:<relPath>` — used when the diff's
   *  "new" side is a committed snapshot (checkpoint range) rather than the
   *  live tree. */
  ref?: string;
}

export interface ContextLinesResult {
  /** The requested slice. Shorter than `end - start + 1` when the file ends
   *  before `end`. */
  lines: string[];
  /** Echoed 1-based first line of `lines` (clamped to >= 1). */
  start: number;
  /** Total line count of the file at this ref. */
  totalLines: number;
  /** True when `end` reached (or passed) the last line — there is nothing
   *  further below to expand. */
  eof: boolean;
}

/**
 * Read a contiguous range of lines from a file so the diff viewer can
 * reveal the unchanged context around hunks ("expand lines" in GitHub's
 * UI). The expandable region is, by definition, identical on both diff
 * sides, so a single read of the appropriate side is enough — the caller
 * maps the old line numbers via the constant gap offset.
 *
 * Path safety mirrors `readMarkdownContent` in diff-pipeline: the textual
 * `relPath` is rejected if it escapes `root`, and the working-tree read is
 * symlink-canonicalised so a `notes.md -> /etc/passwd` symlink can't
 * exfiltrate an out-of-tree file into the payload.
 *
 * Returns `null` when the path is rejected or the content can't be read
 * (missing file, unknown ref, binary). Callers surface that as a 404/400.
 */
export function readContextLines(
  opts: ContextLinesOptions,
): ContextLinesResult | null {
  const { root, relPath, ref } = opts;
  if (!relPath || !isInsideRoot(root, relPath)) return null;

  const start = Math.max(1, Math.floor(opts.start));
  const end = Math.max(start, Math.floor(opts.end));

  const content =
    !ref || ref === 'working'
      ? readWorkingTree(root, relPath)
      : readAtRef(root, ref, relPath);
  if (content === null) return null;

  // Split on either line ending; drop the trailing empty element a final
  // newline produces so `totalLines` matches the line count git/editors
  // report. Matches how `parseGitDiff` strips line endings from hunk text,
  // so revealed context lines render identically to diff context lines.
  const all = content.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();

  const totalLines = all.length;
  // start past EOF → empty slice, eof true.
  const slice = all.slice(start - 1, end);
  return {
    lines: slice,
    start,
    totalLines,
    eof: end >= totalLines,
  };
}

/** Symlink-safe working-tree read. Returns null on any failure. */
function readWorkingTree(root: string, relPath: string): string | null {
  try {
    const absPath = path.join(root, relPath);
    const realRoot = fs.realpathSync(path.resolve(root));
    const realPath = fs.realpathSync(absPath);
    const sep = path.sep;
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
      return null;
    }
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** `git show <ref>:<relPath>`. Uses cross-spawn directly (not the trimming
 *  `git()` helper) so trailing newlines survive. Returns null on failure. */
function readAtRef(root: string, ref: string, relPath: string): string | null {
  const r = spawn.sync('git', ['show', `${ref}:${relPath}`], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status === 0 && typeof r.stdout === 'string') return r.stdout;
  return null;
}
