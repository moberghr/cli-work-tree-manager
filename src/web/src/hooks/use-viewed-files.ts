import { useCallback, useEffect, useMemo, useState } from 'react';
import { readScope, setViewed } from '../state/viewed-files.js';

/**
 * Which files a tick says are viewed, from the stored keys: `path#signature`
 * (the file's change when it was ticked: fileSignature) holds while the
 * file's change is still that one; a bare `path` (ticked before signatures)
 * holds as it is. Without `signatures` every tick holds. Pure.
 */
export function viewedFrom(keys: Set<string>, signatures?: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const at = k.lastIndexOf('#');
    if (at < 0) {
      out.add(k);
      continue;
    }
    const path = k.slice(0, at);
    if (!signatures || signatures.get(path) === k.slice(at + 1)) out.add(path);
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
} {
  const [keys, setKeys] = useState<Set<string>>(() => readScope(scopeKey));

  // Reload from disk when the scope key changes.
  useEffect(() => {
    setKeys(readScope(scopeKey));
  }, [scopeKey]);

  const viewedPaths = useMemo(() => viewedFrom(keys, signatures), [keys, signatures]);

  const toggle = useCallback(
    (path: string, next: boolean) => {
      // One tick per file: drop the old one (its old change, or a bare path) first.
      for (const k of readScope(scopeKey)) if (k === path || k.startsWith(`${path}#`)) setViewed(scopeKey, k, false);
      const sig = signatures?.get(path);
      if (next) setViewed(scopeKey, sig ? `${path}#${sig}` : path, true);
      setKeys(readScope(scopeKey));
    },
    [scopeKey, signatures],
  );

  const viewedAnchors = new Set<string>();
  for (const p of viewedPaths) {
    const anchor = pathToAnchor.get(p);
    if (anchor) viewedAnchors.add(anchor);
  }

  return { viewedPaths, viewedAnchors, toggle };
}
