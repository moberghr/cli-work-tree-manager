import { useCallback, useEffect, useState } from 'react';
import { readScope, setViewed } from '../state/viewed-files.js';

/**
 * Track which file paths are marked "viewed" within a given scope (a wd -c
 * review scope label or a session id). Persists to localStorage.
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
): {
  viewedPaths: Set<string>;
  viewedAnchors: Set<string>;
  toggle: (path: string, next: boolean) => void;
} {
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(() =>
    readScope(scopeKey),
  );

  // Reload from disk when the scope key changes.
  useEffect(() => {
    setViewedPaths(readScope(scopeKey));
  }, [scopeKey]);

  const toggle = useCallback(
    (path: string, next: boolean) => {
      setViewed(scopeKey, path, next);
      setViewedPaths((prev) => {
        const out = new Set(prev);
        if (next) out.add(path);
        else out.delete(path);
        return out;
      });
    },
    [scopeKey],
  );

  const viewedAnchors = new Set<string>();
  for (const p of viewedPaths) {
    const anchor = pathToAnchor.get(p);
    if (anchor) viewedAnchors.add(anchor);
  }

  return { viewedPaths, viewedAnchors, toggle };
}
