/**
 * PURE — the block of import lines a new file starts with (`using`, `import`,
 * `#include`, `package`, `require`, `from … import`), which a review folds
 * into one "N import lines" row: nobody reviews them, and on a new C# file
 * they were the first screen of the diff. Comments and blank lines before it
 * are left alone; blank lines inside it fold with it; a statement spread over
 * lines (`import {` … `} from 'x'`, Go's `import (` … `)`) counts as one.
 */

const IMPORT =
  /^\s*(?:(?:global\s+)?using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[\w.<>, ]+)?\s*;|import\b|#\s*include\b|#\s*import\b|package\s+[\w.]+\s*;?\s*$|from\s+[\w.]+\s+import\b|(?:const|let|var)\s+[\w{}\s,]+=\s*require\(|require\(|@import\b|use\s+[\w\\:{}, ]+;)/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|\*\/|#!|<\?php)/;
const BLANK = /^\s*$/;

/** The lines to fold (0-based, `first`..`last` inclusive) and how many of them are imports; null below `min` imports. */
export function leadingImports(lines: string[], min = 3): { first: number; last: number; count: number } | null {
  let i = 0;
  while (i < lines.length && (BLANK.test(lines[i]) || (COMMENT.test(lines[i]) && !IMPORT.test(lines[i])))) i++;
  const first = i;
  let last = -1;
  let count = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (BLANK.test(l)) {
      i++;
      continue;
    }
    if (!IMPORT.test(l)) break;
    count++;
    // A statement over several lines: `import {` … `}` / Go's `import (` … `)`.
    const open = /^\s*import\s*\($/.test(l) ? ')' : /\{[^}]*$/.test(l) ? '}' : null;
    if (open) {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(open)) j++;
      if (j >= lines.length) break;
      i = j;
    }
    last = i;
    i++;
  }
  return count >= min && last >= first ? { first, last, count } : null;
}
