import type { MenuItem } from '../components/Dashboard/RowMenu.js';
import { flattenTreeFiles, type TreeNode } from '../utils/tree.js';

/** The files a right-click in the tree acts on: the file itself, or every file under the folder (as the tree shows it). */
export function filesUnder(node: TreeNode): Array<{ path: string; anchor: string }> {
  return flattenTreeFiles([node]).map((leaf) => ({ path: leaf.file.path, anchor: `wd-file-${leaf.index}` }));
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
