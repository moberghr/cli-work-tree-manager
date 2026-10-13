import type { MenuItem } from '../components/Dashboard/RowMenu.js';
import { anchorFor, flattenTreeFiles, type TreeNode } from '../utils/tree.js';

/** The files a right-click in the tree acts on: the file itself, or every file under the folder (as the tree shows it). */
export function filesUnder(node: TreeNode): Array<{ path: string; anchor: string }> {
  return flattenTreeFiles([node]).map((leaf) => ({ path: leaf.file.path, anchor: anchorFor(leaf.index) }));
}

/**
 * The tree's right-click menu: mark them viewed (those that aren't yet), mark them not viewed (those that are) — only
 * what would change something. Pure.
 */
export function viewedMenuItems(
  files: Array<{ path: string; anchor: string }>,
  viewedAnchors: Set<string>,
  mark: (paths: string[], viewed: boolean) => void,
): MenuItem[] {
  const seen = files.filter((f) => viewedAnchors.has(f.anchor)).map((f) => f.path);
  const unseen = files.filter((f) => !viewedAnchors.has(f.anchor)).map((f) => f.path);
  const one = files.length === 1;
  const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
  const items: MenuItem[] = [];
  if (unseen.length > 0)
    items.push({ label: one ? 'Mark as viewed' : `Mark ${n(unseen.length)} as viewed`, run: () => mark(unseen, true) });
  if (seen.length > 0)
    items.push({ label: one ? 'Mark as not viewed' : `Mark ${n(seen.length)} as not viewed`, run: () => mark(seen, false) });
  return items;
}

/** The nearest ancestor that scrolls (the diff pane), else the page, and where its visible part starts. */
function scrollerOf(el: HTMLElement): { scrollBy: (x: number, y: number) => void; top: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) {
      return { scrollBy: (x, dy) => p.scrollBy(x, dy), top: p.getBoundingClientRect().top };
    }
  }
  return { scrollBy: (x, dy) => window.scrollBy(x, dy), top: 0 };
}

/**
 * Run `mark` and keep the reader where they were: marking a folder viewed collapses every file in it at once, and the
 * ones above the reader would otherwise pull the diff up under them by their whole height. The file article the
 * reader is in is held at the same place on screen, once the collapse has laid out (two frames, as DiffFile's own
 * toggle waits).
 */
export function keepReadingPlace(mark: () => void): void {
  const articles = [...document.querySelectorAll<HTMLElement>('article.wd-file')];
  // The pane's own top, not the window's: in the dashboard the header and toolbar sit above it, and a file
  // ending under them isn't the one being read.
  const scroller = articles[0] ? scrollerOf(articles[0]) : null;
  const at = scroller ? articles.find((a) => a.getBoundingClientRect().bottom > scroller.top) : undefined;
  const before = at?.getBoundingClientRect().top;
  mark();
  if (!at || !scroller || before === undefined) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!at.isConnected) return;
      const moved = at.getBoundingClientRect().top - before;
      if (moved !== 0) scroller.scrollBy(0, moved);
    }),
  );
}
