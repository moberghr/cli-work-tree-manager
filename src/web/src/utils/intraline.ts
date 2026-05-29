import { diffWordsWithSpace } from 'diff';
import type { Hunk, HunkLine } from '../api/client.js';

export interface IntraSpan {
  text: string;
  changed: boolean;
}

export interface SideRow {
  oldNum: number | null;
  oldContent: string;
  oldKind: 'context' | 'delete' | 'empty';
  newNum: number | null;
  newContent: string;
  newKind: 'context' | 'add' | 'empty';
  oldSpans?: IntraSpan[];
  newSpans?: IntraSpan[];
}

const INTRA_MAX_PAIR_LEN = 5000;
const INTRA_MERGE_GAP_MAX = 3;

/** Coalesce changed runs separated by short unchanged gaps (`.`, ` `, `, `, etc.)
 *  into one block. Without this, `7.2.0` → `10.1.7` highlights as three
 *  disjoint pieces; GitHub merges them into one. */
function mergeAdjacentChanges(spans: IntraSpan[]): IntraSpan[] {
  const out: IntraSpan[] = [];
  let i = 0;
  while (i < spans.length) {
    if (!spans[i].changed) {
      out.push(spans[i]);
      i++;
      continue;
    }
    let j = i;
    while (
      j + 2 < spans.length &&
      !spans[j + 1].changed &&
      spans[j + 1].text.length <= INTRA_MERGE_GAP_MAX &&
      spans[j + 2].changed
    ) {
      j += 2;
    }
    if (j === i) {
      out.push(spans[i]);
      i++;
    } else {
      const merged = spans.slice(i, j + 1).map((s) => s.text).join('');
      out.push({ text: merged, changed: true });
      i = j + 1;
    }
  }
  return out;
}

export function computeIntraLine(
  oldContent: string,
  newContent: string,
): { oldSpans: IntraSpan[]; newSpans: IntraSpan[] } | null {
  if (oldContent.length + newContent.length > INTRA_MAX_PAIR_LEN) return null;
  const parts = diffWordsWithSpace(oldContent, newContent);
  const oldSpans: IntraSpan[] = [];
  const newSpans: IntraSpan[] = [];
  for (const p of parts) {
    if (p.added) {
      newSpans.push({ text: p.value, changed: true });
    } else if (p.removed) {
      oldSpans.push({ text: p.value, changed: true });
    } else {
      oldSpans.push({ text: p.value, changed: false });
      newSpans.push({ text: p.value, changed: false });
    }
  }
  return {
    oldSpans: mergeAdjacentChanges(oldSpans),
    newSpans: mergeAdjacentChanges(newSpans),
  };
}

/** Pair adjacent -/+ lines into side-by-side rows. Unpaired runs render
 *  as half-empty rows on the side that ran out. */
export function pairLines(lines: HunkLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];

  const flush = () => {
    const max = Math.max(dels.length, adds.length);
    for (let i = 0; i < max; i++) {
      const d = dels[i];
      const a = adds[i];
      const row: SideRow = {
        oldNum: d ? d.oldNum : null,
        oldContent: d ? d.content : '',
        oldKind: d ? 'delete' : 'empty',
        newNum: a ? a.newNum : null,
        newContent: a ? a.content : '',
        newKind: a ? 'add' : 'empty',
      };
      if (d && a) {
        const intra = computeIntraLine(d.content, a.content);
        if (intra) {
          row.oldSpans = intra.oldSpans;
          row.newSpans = intra.newSpans;
        }
      }
      rows.push(row);
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === 'no-newline') continue;
    if (line.kind === 'delete') {
      dels.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else {
      flush();
      rows.push({
        oldNum: line.oldNum,
        oldContent: line.content,
        oldKind: 'context',
        newNum: line.newNum,
        newContent: line.content,
        newKind: 'context',
      });
    }
  }
  flush();
  return rows;
}

export function hunkRows(hunk: Hunk): SideRow[] {
  return pairLines(hunk.lines);
}
