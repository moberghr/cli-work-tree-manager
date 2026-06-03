import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import { git } from './git.js';
import {
  parseGitDiff,
  type MarkdownContent,
  type ParsedFile,
} from './diff-parse.js';
import { coverageLookup } from './lcov.js';

const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;

/** Per-side cap on markdown content embedded in the diff payload. A
 *  256 KiB ceiling covers normal docs (README, CHANGELOG up to a year
 *  of releases, design docs) while preventing auto-generated multi-MB
 *  markdown (API refs, vendored docs) from ballooning SSE reload
 *  traffic and the browser heap. When either side hits the cap, both
 *  sides are dropped and `tooLarge: true` is set so the SPA hides the
 *  Preview/Split toggle. */
const MARKDOWN_SIZE_CAP = 256 * 1024;

function isMarkdownPath(p: string): boolean {
  return p !== '/dev/null' && MARKDOWN_EXT_RE.test(p);
}

/**
 * Reject paths that would resolve outside the repo root. Diff output is
 * parsed text — a pathological commit (or a manipulated diff stream) could
 * carry `../../etc/passwd`-style entries. Without this check, the markdown
 * "after" read would happily exfiltrate arbitrary local files into the
 * SPA's diff payload.
 *
 * Exported for unit testing — also useful to other call sites that
 * consume `ParsedFile.path` for filesystem access.
 */
export function isInsideRoot(root: string, rel: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, rel);
  // path.relative returns "" for the same dir, "subdir/x" for nested, or
  // a "../" path for escapes — easiest portable check.
  const r = path.relative(resolvedRoot, resolvedTarget);
  if (r === '') return true;
  if (r.startsWith('..')) return false;
  if (path.isAbsolute(r)) return false;
  return true;
}

/**
 * For markdown files, fetch the "before" content via `git show <fromRef>:<oldPath>`
 * and the "after" content either from the working tree (when comparing
 * against the working tree) or from `git show <toRef>:<newPath>` (when
 * comparing two committed snapshots). Either side may be absent for added
 * / deleted / failed fetches.
 *
 * Uses `cross-spawn` directly (not the `git()` helper) because that helper
 * trims stdout, which would silently drop trailing newlines in the source.
 */
function readMarkdownContent(
  root: string,
  file: ParsedFile,
  fromRef: string,
  toRef: string | 'working',
): MarkdownContent | undefined {
  if (file.isBinary) return undefined;
  if (!isMarkdownPath(file.oldPath) && !isMarkdownPath(file.newPath)) {
    return undefined;
  }

  const showAt = (ref: string, p: string): string | undefined => {
    const r = spawn.sync('git', ['show', `${ref}:${p}`], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.status === 0 && typeof r.stdout === 'string') return r.stdout;
    return undefined;
  };

  const result: MarkdownContent = {};

  if (
    file.status !== 'added' &&
    isMarkdownPath(file.oldPath) &&
    isInsideRoot(root, file.oldPath)
  ) {
    result.before = showAt(fromRef, file.oldPath);
  }

  if (
    file.status !== 'deleted' &&
    isMarkdownPath(file.newPath) &&
    isInsideRoot(root, file.newPath)
  ) {
    if (toRef === 'working') {
      try {
        const absPath = path.join(root, file.newPath);
        // Resolve symlinks BEFORE reading. The `isInsideRoot` check
        // above blocks `../`-style traversal in the textual path, but
        // a repo could legitimately contain a symlink whose target
        // sits outside the worktree (e.g. `notes.md -> /etc/passwd`).
        // Without this, opening a clone of an adversarial repo would
        // exfiltrate the target into the diff payload.
        //
        // Both sides of the containment comparison MUST be canonical:
        // on macOS `/tmp` and `/var` are themselves symlinks (to
        // `/private/tmp` and `/private/var`), and `path.resolve` does
        // NOT follow symlinks — only `realpath` does. Without
        // canonicalising `root` too, every working-tree path under a
        // symlinked ancestor (default `/var/folders/...` TMPDIR target
        // on macOS, plus Linux mounts and Windows directory junctions)
        // resolves to a different namespace from `root`, the relative
        // path comes out `..`-prefixed, and the guard silently rejects
        // legitimate in-repo files.
        const realRoot = fs.realpathSync(path.resolve(root));
        const realPath = fs.realpathSync(absPath);
        const sep = path.sep;
        if (
          realPath === realRoot ||
          realPath.startsWith(realRoot + sep)
        ) {
          result.after = fs.readFileSync(absPath, 'utf-8');
        }
      } catch {
        // Working-tree file missing OR realpath failed — no after-content.
      }
    } else {
      result.after = showAt(toRef, file.newPath);
    }
  }

  if (result.before === undefined && result.after === undefined) {
    return undefined;
  }
  // Drop both sides when either exceeds the cap. We compare byte length
  // (Buffer.byteLength) rather than `.length`, which counts UTF-16
  // code units in JS and undercounts multi-byte characters — the
  // browser pays for bytes, not chars.
  const tooBig =
    (result.before !== undefined &&
      Buffer.byteLength(result.before, 'utf-8') > MARKDOWN_SIZE_CAP) ||
    (result.after !== undefined &&
      Buffer.byteLength(result.after, 'utf-8') > MARKDOWN_SIZE_CAP);
  if (tooBig) {
    return { tooLarge: true };
  }
  return result;
}

export interface ComputeDiffOptions {
  /** Git toplevel working directory. */
  root: string;
  /** Argument to `git diff` (ref, sha, or "HEAD"). */
  diffArg: string;
}

/**
 * Build a tree-sha snapshot of the current working tree (including
 * untracked files, subject to .gitignore) without disturbing the real
 * git index — same temp-`GIT_INDEX_FILE` dance as `checkpoint.ts`. Used
 * by `computeRangeDiff` to do a true tree-vs-tree diff against a
 * checkpoint commit: `git diff <ref>` would otherwise produce phantom
 * "deleted" entries for files that were untracked-at-snapshot-time,
 * because git's working-tree diff goes through the real index and
 * untracked files appear "absent" from its perspective.
 */
function workingTreeTreeSha(root: string): string | null {
  const tmpIndex = path.join(
    os.tmpdir(),
    `wd-diff-${process.pid}-${crypto.randomBytes(6).toString('hex')}.idx`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const run = (args: string[]) =>
    spawn.sync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      env,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    const headExists =
      (
        spawn.sync('git', ['rev-parse', '--verify', 'HEAD'], {
          cwd: root,
          encoding: 'utf-8',
          windowsHide: true,
        }).stdout ?? ''
      ).trim().length > 0;
    if (headExists) {
      const r = run(['read-tree', 'HEAD']);
      if (r.status !== 0) return null;
    }
    const add = run(['add', '-A']);
    if (add.status !== 0) return null;
    const wt = run(['write-tree']);
    if (wt.status !== 0 || !wt.stdout) return null;
    return wt.stdout.trim();
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {
      /* */
    }
  }
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

  const files = parseGitDiff(combined);

  // Attach per-file line-coverage from an lcov.info if the repo has one.
  // Conservative: only files with a confident repo-relative path match get a
  // coverage value; everything else is left undefined (no badge rendered).
  // The lcov parse is memoized by (path, mtimeMs) inside `coverageLookup`, so
  // a multi-MB lcov is NOT re-read on every SSE / chokidar refresh tick.
  attachCoverage(root, files);

  // Augment markdown files with full before/after content so the SPA can
  // render a preview alongside the diff. Cheap (one `git show` + one fs
  // read per .md file), skipped entirely for non-markdown files.
  for (const file of files) {
    const md = readMarkdownContent(root, file, diffArg, 'working');
    if (md) file.mdContent = md;
  }

  return files;
}

/**
 * Attach line-coverage (+ lcov mtime + staleness) to each file in place.
 * Staleness: a file whose working-tree source `mtimeMs` is NEWER than the
 * lcov.info it was measured against has been edited since coverage was last
 * recorded, so its percent is no longer authoritative. We flag it
 * (`coverageStale`) rather than dropping the number outright — the SPA
 * de-emphasizes / suppresses the badge and the tooltip carries the lcov
 * timestamp so stale coverage is never presented as current.
 */
function attachCoverage(root: string, files: ParsedFile[]): void {
  const { byPath, lcovMtimeMs } = coverageLookup(
    root,
    files.map((f) => f.path),
  );
  if (byPath.size === 0) return;
  for (const f of files) {
    const pct = byPath.get(f.path);
    if (typeof pct !== 'number') continue;
    f.coverage = pct;
    if (lcovMtimeMs != null) {
      f.coverageMtimeMs = lcovMtimeMs;
      let srcMtimeMs: number | null = null;
      try {
        srcMtimeMs = fs.statSync(path.join(root, f.path)).mtimeMs;
      } catch {
        srcMtimeMs = null;
      }
      if (srcMtimeMs != null && srcMtimeMs > lcovMtimeMs) {
        f.coverageStale = true;
      }
    }
  }
}

export interface ComputeRangeDiffOptions {
  /** Git toplevel working directory. */
  root: string;
  /** Commit sha (or ref) for the left side. */
  fromRef: string;
  /** Commit sha (or ref) for the right side, or `'working'` for the
   *  working tree (in which case behaviour matches `computeDiff` and
   *  untracked files are synthesised). */
  toRef: string | 'working';
}

/**
 * Diff between two snapshot points. When `toRef === 'working'` this is
 * `computeDiff` with the same diffArg — the only path that needs untracked
 * synthesis. When `toRef` is a real commit, both sides are committed trees
 * (checkpoints already include what was untracked at capture time via the
 * temp-index `git add -A`), so a plain `git diff <from> <to>` covers it.
 *
 * Markdown content is fetched from the appropriate ref on each side so the
 * Preview/Split view works for historical range views too.
 */
export function computeRangeDiff(opts: ComputeRangeDiffOptions): ParsedFile[] {
  const { root, fromRef, toRef } = opts;

  if (toRef === 'working') {
    if (fromRef === 'HEAD') {
      // Legacy HEAD-vs-working path — keep the existing untracked
      // synthesis. This is what `wd` (no checkpoints) has always done.
      return computeDiff({ root, diffArg: fromRef });
    }
    // Range against a real checkpoint commit. `git diff <ref>` can't be
    // used directly here: it routes through the real index, so any file
    // that was untracked-at-snapshot-time (and captured into the
    // checkpoint's tree via the temp-index `add -A`) appears DELETED
    // from the working tree — a phantom that would render as
    // "removed" on every range view. Build a tree-sha snapshot of the
    // live working tree (same temp-index dance) and do a clean
    // tree-vs-tree diff. No untracked synth needed; the working-tree
    // tree already contains everything.
    const wtTreeSha = workingTreeTreeSha(root);
    if (!wtTreeSha) return [];
    const result = spawn.sync(
      'git',
      ['diff-tree', '-r', '-p', '--no-color', '--no-ext-diff', fromRef, wtTreeSha],
      {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 500 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      if (result.stderr) console.error(result.stderr);
      return [];
    }
    const parsed = parseGitDiff(result.stdout);
    for (const file of parsed) {
      const md = readMarkdownContent(root, file, fromRef, 'working');
      if (md) file.mdContent = md;
    }
    return parsed;
  }

  // No `-w` here. `computeDiff` (HEAD-vs-working-tree) uses `-w` to hide
  // reformatting noise — but checkpoint-to-checkpoint diffs are user-
  // selected ranges where a whitespace-only change between snapshots is
  // a legitimate change the user explicitly asked to see. Suppressing it
  // would make the strip silently show "no changes" for a turn that did
  // exactly one reformatting pass.
  const result = spawn.sync(
    'git',
    ['diff', '--no-color', '--no-ext-diff', fromRef, toRef],
    {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 500 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    if (result.stderr) console.error(result.stderr);
    return [];
  }

  const files = parseGitDiff(result.stdout);
  for (const file of files) {
    const md = readMarkdownContent(root, file, fromRef, toRef);
    if (md) file.mdContent = md;
  }
  return files;
}
