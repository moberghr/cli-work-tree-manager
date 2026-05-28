import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { git } from './git.js';
import { parseGitDiff, type ParsedFile } from './diff-parse.js';

export interface ComputeDiffOptions {
  /** Git toplevel working directory. */
  root: string;
  /** Argument to `git diff` (ref, sha, or "HEAD"). */
  diffArg: string;
}

/**
 * Detect binary content by scanning the first 8 KiB for null bytes. Matches
 * what most text-handling tools (git itself, less, vim) use as a heuristic.
 */
function isBinaryContent(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Render a unified-diff block for a single untracked file as if it were
 * being added. Avoids mutating the git index (which the previous
 * `add --intent-to-add` / `reset` approach did, with risk of leaving stale
 * index entries on crash).
 */
function synthesizeUntrackedDiff(root: string, relPath: string): string {
  const absPath = path.join(root, relPath);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return '';
  }

  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n`;

  if (isBinaryContent(buffer)) {
    return `${header}Binary files /dev/null and b/${relPath} differ\n`;
  }

  const content = buffer.toString('utf-8');
  if (content.length === 0) {
    // Empty file — no hunks, just the headers.
    return `${header}--- /dev/null\n+++ b/${relPath}\n`;
  }

  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) lines.pop();

  let out = `${header}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) {
    out += `+${line}\n`;
  }
  if (!hasTrailingNewline) {
    out += `\\ No newline at end of file\n`;
  }
  return out;
}

/**
 * Run `git diff <ref>` against the working tree, then synthesize unified-diff
 * blocks for any untracked files (so they show up as new). Read-only — no
 * changes to the git index, safe under concurrent invocations and crash.
 */
export function computeDiff(opts: ComputeDiffOptions): ParsedFile[] {
  const { root, diffArg } = opts;

  const trackedResult = spawn.sync(
    'git',
    // -w (ignore-all-space) hides pure whitespace changes so a reformat
    // of indentation doesn't drown out the real changes.
    ['diff', '--no-color', '--no-ext-diff', '-w', diffArg],
    {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 500 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (trackedResult.status !== 0) {
    if (trackedResult.stderr) console.error(trackedResult.stderr);
    return [];
  }

  let combined = trackedResult.stdout;

  // Append synthetic diffs for untracked files (respecting .gitignore).
  const untrackedResult = git(
    ['ls-files', '--others', '--exclude-standard'],
    root,
  );
  if (untrackedResult.exitCode === 0 && untrackedResult.stdout) {
    const files = untrackedResult.stdout.split('\n').filter(Boolean);
    for (const file of files) {
      const block = synthesizeUntrackedDiff(root, file);
      if (block) combined += block;
    }
  }

  return parseGitDiff(combined);
}
