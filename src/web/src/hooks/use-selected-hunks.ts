import { useCallback, useEffect, useState } from 'react';
import { readScope, setSelected } from '../state/selected-hunks.js';

/**
 * Track which hunk keys are checked off within a given scope (a wd -c
 * review scope label + ':hunks', or a session id + ':hunks'). Persists to
 * localStorage. Mirrors useViewedFiles — this is client-side review
 * progress state, no server contract.
 *
 * Returns:
 *   selectedHunkKeys — Set of hunk keys currently selected.
 *   toggle(hunkKey, next) — mutator.
 */
export function useSelectedHunks(scopeKey: string): {
  selectedHunkKeys: Set<string>;
  toggle: (hunkKey: string, next: boolean) => void;
} {
  const [selectedHunkKeys, setSelectedHunkKeys] = useState<Set<string>>(() =>
    readScope(scopeKey),
  );

  // Reload from disk when the scope key changes.
  useEffect(() => {
    setSelectedHunkKeys(readScope(scopeKey));
  }, [scopeKey]);

  const toggle = useCallback(
    (hunkKey: string, next: boolean) => {
      setSelected(scopeKey, hunkKey, next);
      setSelectedHunkKeys((prev) => {
        const out = new Set(prev);
        if (next) out.add(hunkKey);
        else out.delete(hunkKey);
        return out;
      });
    },
    [scopeKey],
  );

  return { selectedHunkKeys, toggle };
}
