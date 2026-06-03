import { useEffect, useRef, useState } from 'react';

export interface DeferredLoad<T> {
  /** Latest successfully-fetched value, or null before the first success. */
  data: T | null;
  /** Error message from the most recent failed fetch, cleared on each new run. */
  error: string | null;
  /** True while a fetch is in flight AND has outlasted `delayMs` — so a fast
   *  fetch (e.g. a live-reload on file save) doesn't flash a spinner. */
  loading: boolean;
}

/**
 * Run `fetcher` whenever `deps` change, with stale-response guarding and a
 * deferred "loading" flag suitable for driving a spinner / dim.
 *
 * Why a hook: the diff views (`ReviewApp`, `DiffView`) both need exactly this
 * — re-fetch on scope/range/base/reload changes, ignore a superseded
 * response, and surface in-flight state without flickering on fast fetches.
 * Keeping the timing logic in one place avoids the class of bug where the
 * deferred-show timer outlives the fetch and pins `loading` true forever
 * (the timer MUST be cleared the moment the fetch settles, not only on the
 * next effect run).
 *
 * `fetcher` is read through a ref so its changing identity each render never
 * re-triggers the effect — `deps` is the sole trigger, exactly like a
 * hand-written effect with an explicit dependency array.
 */
export function useDeferredDiffLoad<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  delayMs = 120,
): DeferredLoad<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  // Always call the freshest closure without making it an effect trigger.
  fetcherRef.current = fetcher;

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    const showTimer = setTimeout(() => {
      if (myReq === reqIdRef.current) setLoading(true);
    }, delayMs);
    fetcherRef.current().then(
      (d) => {
        // Clear FIRST, unconditionally: a fetch that settles before the
        // delay must cancel the pending show-timer, else it fires later
        // and strands `loading` true with no effect run left to reset it.
        clearTimeout(showTimer);
        if (myReq !== reqIdRef.current) return;
        setData(d);
        setLoading(false);
      },
      (err: Error) => {
        clearTimeout(showTimer);
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
        setLoading(false);
      },
    );
    return () => clearTimeout(showTimer);
    // `deps` is the caller-supplied trigger list; `fetcher` is intentionally
    // excluded (read via ref above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}
