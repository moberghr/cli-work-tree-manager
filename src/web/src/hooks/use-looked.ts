import { useEffect, useRef } from 'react';

/** Looking = the page is visible and the window has focus. */
const looking = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Calls `onLooked` once you have looked at something for `ms` — counted only
 * while the page is visible and its window focused, so a quick click
 * through, a hidden tab or another app in front doesn't count. Once per
 * `key` (a new key starts over); nothing while `key` is null.
 */
export function useLookedFor(key: string | null, ms: number, onLooked: () => void, tickMs = 1000): void {
  const cb = useRef(onLooked);
  cb.current = onLooked;
  useEffect(() => {
    if (key === null) return;
    let seen = 0;
    const t = setInterval(() => {
      if (!looking()) return;
      seen += tickMs;
      if (seen >= ms) {
        clearInterval(t);
        cb.current();
      }
    }, tickMs);
    return () => clearInterval(t);
  }, [key, ms, tickMs]);
}
