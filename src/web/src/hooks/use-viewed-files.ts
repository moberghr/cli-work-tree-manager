import { useCallback, useEffect, useMemo, useState } from 'react';
import { readScope, updateScope } from '../state/viewed-files.js';

/** A tick's signature part: fileSignature's shape (`added.deleted.hash`), so a `#` in a path is never taken for one. */
const SIGNED = /#(\d+\.\d+\.[0-9a-z]+)$/;

/** A stored tick: `path#signature`, or a bare `path` (from before signatures, or the wd page's, which has none). Pure. */
export function tickOf(key: string): { path: string; signature?: string } {
  const m = SIGNED.exec(key);
  return m ? { path: key.slice(0, m.index), signature: m[1] } : { path: key };
}

/**
 * Which files a tick says are viewed, from the stored keys: `path#signature`
 * (the file's change when it was ticked: fileSignature) holds while the
 * file's change is still that one; a bare `path` (ticked before signatures)
 * holds as it is. Without `signatures` every tick holds. Pure.
 */
export function viewedFrom(keys: Set<string>, signatures?: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const { path, signature } = tickOf(k);
    if (signature === undefined || !signatures || signatures.get(path) === signature) out.add(path);
  }
  return out;
}

/**
 * Track which file paths are marked "viewed" within a given scope (a wd -c
 * review scope label or a session id). Persists to localStorage.
 *
 * With `signatures` (path → the file's change, the dashboard's diff), a tick
 * holds only while the file still has the change it was given for: a file
 * Claude touched again is unticked, as GitHub does.
 *
 * Returns:
 *   viewedPaths — Set of `file.path`s currently marked viewed.
 *   viewedAnchors — Set of `wd-file-<n>` anchors derived from viewedPaths,
 *     suitable for handing to the sidebar tree.
 *   toggle(path, next) — mutator.
 */
export function useViewedFiles(
  scopeKey: string,
  pathToAnchor: Map<string, string>,
  signatures?: Map<string, string>,
): {
  viewedPaths: Set<string>;
  viewedAnchors: Set<string>;
  toggle: (path: string, next: boolean) => void;
  /** Several at once (a folder's files, from the tree's right-click): one store pass, one render. */
  setMany: (paths: string[], next: boolean) => void;
} {
  const [keys, setKeys] = useState<Set<string>>(() => readScope(scopeKey));

  // Reload from disk when the scope key changes.
  useEffect(() => {
    setKeys(readScope(scopeKey));
  }, [scopeKey]);

  const viewedPaths = useMemo(() => viewedFrom(keys, signatures), [keys, signatures]);

  const setMany = useCallback(
    (paths: string[], next: boolean) => {
      const these = new Set(paths);
      const after = updateScope(scopeKey, (keys) => {
        // One tick per file: drop the old one (its old change, or a bare path) first.
        for (const k of [...keys]) if (these.has(tickOf(k).path)) keys.delete(k);
        if (!next) return;
        for (const path of paths) {
          const sig = signatures?.get(path);
          keys.add(sig ? `${path}#${sig}` : path);
        }
      });
      setKeys(after);
    },
    [scopeKey, signatures],
  );
  const toggle = useCallback((path: string, next: boolean) => setMany([path], next), [setMany]);

  const viewedAnchors = new Set<string>();
  for (const p of viewedPaths) {
    const anchor = pathToAnchor.get(p);
    if (anchor) viewedAnchors.add(anchor);
  }

  return { viewedPaths, viewedAnchors, toggle, setMany };
}
