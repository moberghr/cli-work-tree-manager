import type { ParsedFile } from '../api/client.js';

export interface TreeFileLeaf {
  kind: 'file';
  name: string;
  file: ParsedFile;
  index: number;
}

export interface TreeDirNode {
  kind: 'dir';
  name: string;
  children: TreeNode[];
}

export type TreeNode = TreeFileLeaf | TreeDirNode;

export interface IndexedFile {
  file: ParsedFile;
  index: number;
}

interface DirBuilder {
  children: Map<string, DirBuilder>;
  files: IndexedFile[];
}

/**
 * Build a file tree from a list of files with their global anchor indices.
 *
 * Two call shapes — pass `ParsedFile[]` with a `startIndex` for sequential
 * indices (the unfiltered case), or pre-indexed `{file, index}` tuples for
 * the filtered case where indices need to survive after some files drop out.
 */
export function buildTree(files: ParsedFile[], startIndex?: number): TreeNode[];
export function buildTree(items: IndexedFile[]): TreeNode[];
export function buildTree(
  arg: ParsedFile[] | IndexedFile[],
  startIndex = 0,
): TreeNode[] {
  const items: IndexedFile[] =
    arg.length === 0
      ? []
      : 'file' in (arg[0] as object)
        ? (arg as IndexedFile[])
        : (arg as ParsedFile[]).map((f, i) => ({
            file: f,
            index: startIndex + i,
          }));

  const root: DirBuilder = { children: new Map(), files: [] };
  for (const item of items) {
    const parts = item.file.path.split('/').filter(Boolean);
    const dirs = parts.slice(0, -1);
    let node = root;
    for (const dir of dirs) {
      let child = node.children.get(dir);
      if (!child) {
        child = { children: new Map(), files: [] };
        node.children.set(dir, child);
      }
      node = child;
    }
    node.files.push(item);
  }

  function emit(node: DirBuilder): TreeNode[] {
    const entries: TreeNode[] = [];
    for (const [name, child] of node.children) {
      entries.push({ kind: 'dir', name, children: emit(child) });
    }
    for (const f of node.files) {
      const filename = f.file.path.split('/').pop() ?? f.file.path;
      entries.push({
        kind: 'file',
        name: filename,
        file: f.file,
        index: f.index,
      });
    }
    entries.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    return entries;
  }
  return emit(root);
}

export function flattenTreeFiles(nodes: TreeNode[]): TreeFileLeaf[] {
  const out: TreeFileLeaf[] = [];
  function walk(ns: TreeNode[]) {
    for (const n of ns) {
      if (n.kind === 'file') out.push(n);
      else walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

/** Lowercase haystack of `path` segments, for filter matching. */
export function fileMatches(file: ParsedFile, q: string): boolean {
  if (!q) return true;
  return file.path.toLowerCase().includes(q);
}
