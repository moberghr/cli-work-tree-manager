import { useCallback, useEffect, useState } from 'react';
import { readScope, setReviewed } from '../state/reviewed-hunks.js';

/**
 * Track which hunk keys are checked off ("reviewed") within a given scope (a
 * wd -c review scope label + ':hunks', or a session id + ':hunks'). Persists
 * to localStorage. Mirrors useViewedFiles — this is client-side review
 * progress state, no server contract.
 *
 * Returns:
 *   reviewedHunkKeys — Set of hunk keys currently marked reviewed.
 *   toggle(hunkKey, next) — mutator.
 */
export function useReviewedHunks(scopeKey: string): {
  reviewedHunkKeys: Set<string>;
  toggle: (hunkKey: string, next: boolean) => void;
} {
  const [reviewedHunkKeys, setReviewedHunkKeys] = useState<Set<string>>(() =>
    readScope(scopeKey),
  );

  // Reload from disk when the scope key changes.
  useEffect(() => {
    setReviewedHunkKeys(readScope(scopeKey));
  }, [scopeKey]);

  const toggle = useCallback(
    (hunkKey: string, next: boolean) => {
      setReviewed(scopeKey, hunkKey, next);
      setReviewedHunkKeys((prev) => {
        const out = new Set(prev);
        if (next) out.add(hunkKey);
        else out.delete(hunkKey);
        return out;
      });
    },
    [scopeKey],
  );

  return { reviewedHunkKeys, toggle };
}
