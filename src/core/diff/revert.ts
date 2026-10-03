import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { git } from '../git/git.js';
import type { ParsedFile } from './diff-parse.js';

/**
 * Undo part of a worktree's uncommitted change: a whole file, or the lines
 * of one hunk. Both act on the working tree against HEAD — exactly what
 * the Uncommitted diff shows — and never touch commits.
 *
 * Hunk revert does not trust the displayed hunk (the diff pipeline runs
 * with `-w`, and the parser drops CRs): it asks git for the raw, byte-exact
 * diff of that one file and reverse-applies the raw hunks that overlap the
 * lines the user picked, after a `--check` dry run. If the file moved on
 * since the user looked, the check fails and nothing is written.
 */

export type RevertOutcome = { ok: true; description: string } | { ok: false; status: 400 | 409; error: string };

/** A repo-relative path, resolved inside `root` — or null if it escapes. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const back = path.relative(path.resolve(root), abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return abs;
}

function inHead(root: string, rel: string): boolean {
  return git(['cat-file', '-e', `HEAD:${rel}`], root).exitCode === 0;
}

/** Forget a path that HEAD doesn't have: drop it from the index and disk. */
function removeNew(root: string, rel: string): RevertOutcome | null {
  const abs = inside(root, rel);
  if (!abs) return { ok: false, status: 400, error: `path escapes the worktree: ${rel}` };
  git(['rm', '--cached', '-q', '--ignore-unmatch', '--', rel], root);
  fs.rmSync(abs, { force: true });
  return null;
}

/** Put the whole file back to HEAD (deleting it if HEAD doesn't have it). */
export function revertFile(root: string, file: ParsedFile): RevertOutcome {
  const gone = file.status === 'renamed' ? file.oldPath : file.path;
  for (const rel of new Set([file.oldPath, file.path])) {
    if (!inside(root, rel)) return { ok: false, status: 400, error: `path escapes the worktree: ${rel}` };
  }
  if (file.status === 'renamed' || file.status === 'added' || !inHead(root, file.path)) {
    const err = removeNew(root, file.path);
    if (err) return err;
  }
  if (file.status !== 'added' && inHead(root, gone)) {
    const r = git(['restore', '--source=HEAD', '--staged', '--worktree', '--', gone], root);
    if (r.exitCode !== 0) return { ok: false, status: 409, error: r.stderr || 'git restore failed' };
  }
  return { ok: true, description: `reverted ${file.path}` };
}

/**
 * The new-side lines a hunk actually changes — its context left out. An
 * added line counts at its own number; a deleted line at the position it
 * was removed from (the next new-side line). Null for a hunk that changes
 * nothing.
 */
export function changedSpan(newStart: number, kinds: Array<'+' | '-' | ' '>): { start: number; end: number } | null {
  let cur = newStart;
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of kinds) {
    if (k === ' ') {
      cur++;
      continue;
    }
    lo = Math.min(lo, cur);
    hi = Math.max(hi, cur);
    if (k === '+') cur++;
  }
  return lo === Infinity ? null : { start: lo, end: hi };
}

/** A raw diff's header and hunks, each with the lines it changes. */
export function splitHunks(raw: string): {
  header: string;
  hunks: Array<{ text: string; newStart: number; newEnd: number; changed: { start: number; end: number } | null }>;
} {
  const at = raw.search(/^@@ /m);
  if (at < 0) return { header: raw, hunks: [] };
  const header = raw.slice(0, at);
  const hunks: Array<{ text: string; newStart: number; newEnd: number; changed: { start: number; end: number } | null }> = [];
  const parts = raw.slice(at).split(/(?=^@@ )/m);
  for (const text of parts) {
    const m = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const newStart = Number(m[1]);
    const newLines = m[2] === undefined ? 1 : Number(m[2]);
    const kinds = text
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l[0])
      .filter((c): c is '+' | '-' | ' ' => c === '+' || c === '-' || c === ' ');
    // With zero context (-U0) a pure deletion's header names the line BEFORE
    // it; its first "next new-side line" is one further.
    const origin = newLines === 0 ? newStart + 1 : newStart;
    hunks.push({ text, newStart, newEnd: newStart + Math.max(newLines, 1) - 1, changed: changedSpan(origin, kinds) });
  }
  return { header, hunks };
}

/** The changed lines of the displayed hunk the client asked about. */
function displayedSpan(file: ParsedFile, start: number, end: number): { start: number; end: number } {
  const h = file.hunks.find((x) => x.newStart === start && x.newStart + Math.max(x.newLines, 1) - 1 === end);
  if (!h) return { start, end };
  const kinds = h.lines
    .map((l) => (l.kind === 'add' ? '+' : l.kind === 'delete' ? '-' : l.kind === 'context' ? ' ' : null))
    .filter((k): k is '+' | '-' | ' ' => k !== null);
  return changedSpan(h.newStart, kinds) ?? { start, end };
}

/**
 * Undo the uncommitted changes to the hunk at new-side lines [start, end]
 * of `file`.
 *
 * The displayed hunk comes from a whitespace-insensitive diff; git's raw
 * diff is taken with zero context so every change is its own hunk, and only
 * the raw hunks whose CHANGED lines touch the displayed hunk's changed
 * lines are reverted. (Matching by context-inclusive ranges also reverted
 * a hidden whitespace-only change a few lines away, without saying so.)
 */
export function revertLines(root: string, file: ParsedFile, start: number, end: number): RevertOutcome {
  if (file.isBinary) return { ok: false, status: 400, error: 'binary files can only be reverted whole' };
  if (file.status === 'renamed') return { ok: false, status: 400, error: 'a renamed file can only be reverted whole' };
  if (!inside(root, file.path)) return { ok: false, status: 400, error: `path escapes the worktree: ${file.path}` };
  // An untracked or newly added file is one hunk: reverting it removes it.
  if (!inHead(root, file.path)) return revertFile(root, file);

  const diff = spawn.sync('git', ['diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', file.path], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true,
  });
  if (diff.status !== 0) return { ok: false, status: 409, error: (diff.stderr ?? '').toString() || 'git diff failed' };
  const { header, hunks } = splitHunks((diff.stdout ?? '').toString());
  const want = displayedSpan(file, start, end);
  const picked = hunks.filter((h) => h.changed && h.changed.start <= want.end && h.changed.end >= want.start);
  if (picked.length === 0) return { ok: false, status: 409, error: 'that change is no longer in the file — reload the diff' };
  const patch = header + picked.map((h) => h.text).join('');

  const apply = (check: boolean) =>
    spawn.sync('git', ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', ...(check ? ['--check'] : []), '-'], {
      cwd: root,
      input: patch,
      encoding: 'utf-8',
      windowsHide: true,
    });
  const dry = apply(true);
  if (dry.status !== 0) {
    return { ok: false, status: 409, error: `the file changed since — reload the diff (${(dry.stderr ?? '').toString().trim()})` };
  }
  const real = apply(false);
  if (real.status !== 0) return { ok: false, status: 409, error: (real.stderr ?? '').toString().trim() || 'git apply failed' };
  return { ok: true, description: `reverted ${file.path} lines ${start}–${end}` };
}
