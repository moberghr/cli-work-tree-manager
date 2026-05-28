export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface ParsedFile {
  /** Path used by GitHub-style anchors / sidebar tree. For renames, this is the new path. */
  path: string;
  oldPath: string;
  newPath: string;
  status: FileStatus;
  isBinary: boolean;
  added: number;
  deleted: number;
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Trailing text after "@@ ... @@" — typically the enclosing function/class. */
  context: string;
  lines: HunkLine[];
}

export type LineKind = 'context' | 'add' | 'delete' | 'no-newline';

export interface HunkLine {
  kind: LineKind;
  content: string;
  oldNum: number | null;
  newNum: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse the output of `git diff` (or `git diff <ref>`) into a list of files
 * with hunks. The input is assumed to be in unified diff format with the
 * default git headers (`diff --git`, `--- a/...`, `+++ b/...`).
 */
export function parseGitDiff(input: string): ParsedFile[] {
  const lines = input.split(/\r?\n/);
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let currentHunk: Hunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  function startFile(oldPath: string, newPath: string): ParsedFile {
    const f: ParsedFile = {
      path: newPath !== '/dev/null' ? newPath : oldPath,
      oldPath,
      newPath,
      status: 'modified',
      isBinary: false,
      added: 0,
      deleted: 0,
      hunks: [],
    };
    files.push(f);
    return f;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // `diff --git a/path b/path` — start of a new file. We may not learn
    // the real paths until the `---`/`+++` lines below, so just close out
    // the previous file here.
    if (line.startsWith('diff --git ')) {
      current = null;
      currentHunk = null;
      const match = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
      if (match) {
        current = startFile(match[1], match[2]);
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length);
      current.path = current.newPath;
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripPathPrefix(line.slice(4));
      if (p === '/dev/null') {
        current.status = 'added';
      } else {
        current.oldPath = p;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPathPrefix(line.slice(4));
      if (p === '/dev/null') {
        current.status = 'deleted';
      } else {
        current.newPath = p;
        current.path = p;
      }
      continue;
    }

    const hunkMatch = line.match(HUNK_RE);
    if (hunkMatch) {
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
        context: hunkMatch[5].trim(),
        lines: [],
      };
      oldLineNum = currentHunk.oldStart;
      newLineNum = currentHunk.newStart;
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    // Inside a hunk: the first character of each line says what kind it is.
    // We accept empty lines defensively (some diffs trim trailing space).
    const marker = line[0] ?? ' ';
    const body = line.slice(1);

    if (marker === '\\') {
      // "\ No newline at end of file" — attach to previous line, don't count.
      currentHunk.lines.push({
        kind: 'no-newline',
        content: line,
        oldNum: null,
        newNum: null,
      });
      continue;
    }

    if (marker === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content: body,
        oldNum: null,
        newNum: newLineNum++,
      });
      current.added++;
    } else if (marker === '-') {
      currentHunk.lines.push({
        kind: 'delete',
        content: body,
        oldNum: oldLineNum++,
        newNum: null,
      });
      current.deleted++;
    } else {
      // Context (space) and anything else gets treated as context.
      currentHunk.lines.push({
        kind: 'context',
        content: body,
        oldNum: oldLineNum++,
        newNum: newLineNum++,
      });
    }
  }

  // Derive status for renames where the diff omitted /dev/null markers.
  for (const f of files) {
    if (f.status === 'modified' && f.oldPath !== f.newPath) {
      f.status = 'renamed';
    }
  }

  return files;
}

function stripPathPrefix(p: string): string {
  // `--- a/path/to/file` / `+++ b/path/to/file` / `--- /dev/null`
  const trimmed = p.trim().replace(/^"|"$/g, '');
  if (trimmed === '/dev/null') return trimmed;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}
