import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The diff table's row and cell classes belong to diff.css alone. A rule
 * on one of them from any other stylesheet lands on thousands of table
 * cells: a `.wd-context { display: inline-flex }` meant for a header chip
 * collapsed every split-view cell to 50 px (found by a user on a real
 * diff; the demo screenshots had been taken before the chip existed).
 */
const STYLES = path.resolve(__dirname, '../../src/web/src/styles');
/** hljs.css colours the content cells' tokens; that is its job. */
const OWNERS = new Set(['diff.css', 'hljs.css']);
const DIFF_CLASSES = ['wd-row', 'wd-ln', 'wd-content', 'wd-context', 'wd-add', 'wd-delete', 'wd-diff-table', 'wd-col-ln', 'wd-col-content'];

describe('diff table classes', () => {
  it('are styled only by diff.css', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(STYLES)) {
      if (!file.endsWith('.css') || OWNERS.has(file)) continue;
      const css = fs.readFileSync(path.join(STYLES, file), 'utf-8');
      for (const cls of DIFF_CLASSES) {
        // The whole class name (not `.wd-context-menu`), opening a selector:
        // `.wd-tree-stats .wd-add` is scoped to the tree and can't reach a cell.
        const re = new RegExp(`(^|[,{}])\s*\.${cls}(?![\w-])`, 'gm');
        for (const m of css.matchAll(re)) {
          const line = css.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line} .${cls}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
