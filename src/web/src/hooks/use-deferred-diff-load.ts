import { useCallback, useEffect, useRef, useState } from 'react';

export interface DeferredLoad<T> {
  /** Latest applied value, or null before the first success. */
  data: T | null;
  /** Error message from the most recent failed foreground fetch, cleared on
   *  each new run. Background checks never set it (see `checkForUpdates`). */
  error: string | null;
  /** True while a FOREGROUND fetch is in flight AND has outlasted `delayMs`
   *  — so a fast fetch doesn't flash a spinner. Drives the progress bar. */
  loading: boolean;
  /** True while a BACKGROUND check is in flight AND has outlasted `delayMs`.
   *  Drives the header's quiet "checking…" chip; never dims or replaces the
   *  diff. Deferred like `loading` so the common fast check (a local `git
   *  diff` is tens of ms) doesn't flicker a chip in and out of the header on
   *  every file save. */
  checking: boolean;
  /** A background-fetched payload that differs from `data`, held back until
   *  the user asks for it. Null when the view is up to date. */
  pending: T | null;
  /** Swap `pending` into `data`. No-op when nothing is staged. */
  applyPending: () => void;
  /** Foreground refetch: goes back to the server and applies the result the
   *  moment it lands, dropping any staged payload. What a browser refresh
   *  would give you, minus throwing away the page. */
  reload: () => void;
  /** Background refetch: stages the result as `pending` instead of replacing
   *  `data`, so the diff under the user's cursor never moves on its own.
   *  For live-reload signals (SSE `diff-changed`). */
  checkForUpdates: () => void;
}

/** Structural equality over fetched payloads. Used to decide whether a
 *  background check actually found something new — a `diff-changed` event
 *  fires for any write in the scope, including ones that leave the diff
 *  byte-identical (touch, save-with-no-edit, git plumbing churn), and those
 *  must not nag the user with an update banner. */
function samePayload(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Run `fetcher` whenever `deps` change, with stale-response guarding, a
 * deferred "loading" flag suitable for driving a spinner / dim, and a
 * staging slot for live updates.
 *
 * Why a hook: the diff views (`ReviewApp`, `DiffView`) both need exactly this
 * — re-fetch on scope/range/base/reload changes, ignore a superseded
 * response, and surface in-flight state without flickering on fast fetches.
 * Keeping the timing logic in one place avoids the class of bug where the
 * deferred-show timer outlives the fetch and pins `loading` true forever
 * (the timer MUST be cleared the moment the fetch settles, not only on the
 * next effect run).
 *
 * Why staging: file-watch reloads used to land straight in `data`, so the
 * diff re-rendered under the reader — scroll position, hunk offsets and
 * highlight all shifted mid-read whenever Claude (or a save) touched a file.
 * Live signals now go through `checkForUpdates()`, which fetches quietly and
 * parks a genuinely-different result in `pending`; the view shows a
 * GitHub-style "changes available" banner and only swaps on the user's click.
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
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<T | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  // Latest applied payload, readable from a background callback without
  // making `data` an effect dependency.
  const dataRef = useRef<T | null>(null);
  // Bumped by every foreground run (deps change or `reload`). A background
  // check tags itself with the generation it started in and discards its
  // result if the view has moved on — a diff fetched for the old base/range
  // must never be staged against the new one.
  const genRef = useRef(0);
  // Sequence for background checks, independent of `reqIdRef` so a check can
  // never invalidate an in-flight foreground fetch (or vice versa).
  const bgIdRef = useRef(0);
  // Mirror of `pending`, so `applyPending` can read it without a state
  // updater doing side effects (StrictMode double-invokes updaters).
  const pendingRef = useRef<T | null>(null);
  // Always call the freshest closure without making it an effect trigger.
  fetcherRef.current = fetcher;

  const apply = useCallback((d: T) => {
    dataRef.current = d;
    setData(d);
  }, []);

  const stage = useCallback((p: T | null) => {
    pendingRef.current = p;
    setPending(p);
  }, []);

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    const myGen = ++genRef.current;
    setError(null);
    // The staged payload belonged to the previous view (or is about to be
    // superseded by this fetch), so it can't survive this run.
    stage(null);
    const showTimer = setTimeout(() => {
      if (myReq === reqIdRef.current) setLoading(true);
    }, delayMs);
    fetcherRef.current().then(
      (d) => {
        // Clear FIRST, unconditionally: a fetch that settles before the
        // delay must cancel the pending show-timer, else it fires later
        // and strands `loading` true with no effect run left to reset it.
        clearTimeout(showTimer);
        if (myReq !== reqIdRef.current || myGen !== genRef.current) return;
        apply(d);
        setLoading(false);
      },
      (err: Error) => {
        clearTimeout(showTimer);
        if (myReq !== reqIdRef.current || myGen !== genRef.current) return;
        setError(err.message);
        setLoading(false);
      },
    );
    return () => clearTimeout(showTimer);
    // `deps` is the caller-supplied trigger list; `fetcher` is intentionally
    // excluded (read via ref above). `reloadKey` is the `reload()` trigger —
    // it runs the identical foreground path, so a reload clears the staged
    // payload and dims/bars exactly like a base switch does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const checkForUpdates = useCallback(() => {
    const myGen = genRef.current;
    const myReq = ++bgIdRef.current;
    // Same deal as the foreground show-timer: cleared the moment the check
    // settles, so a fast check never flashes (or strands) the chip.
    const showTimer = setTimeout(() => {
      if (myReq === bgIdRef.current) setChecking(true);
    }, delayMs);
    fetcherRef.current().then(
      (d) => {
        clearTimeout(showTimer);
        if (myReq !== bgIdRef.current) return; // superseded by a newer check
        setChecking(false);
        if (myGen !== genRef.current) return; // view moved on — drop it
        // Nothing applied yet (first load still running, or it failed):
        // there's no reading position to protect, so land it directly.
        if (dataRef.current === null) {
          setError(null);
          apply(d);
          return;
        }
        stage(samePayload(d, dataRef.current) ? null : d);
      },
      () => {
        clearTimeout(showTimer);
        if (myReq !== bgIdRef.current) return;
        // Silent: a failed background check leaves the current diff alone.
        // The next file event (or a manual reload) retries.
        setChecking(false);
      },
    );
  }, [apply, stage, delayMs]);

  const applyPending = useCallback(() => {
    const p = pendingRef.current;
    if (p === null) return;
    stage(null);
    apply(p);
  }, [apply, stage]);

  return {
    data,
    error,
    loading,
    checking,
    pending,
    applyPending,
    reload,
    checkForUpdates,
  };
}
