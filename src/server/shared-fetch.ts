/**
 * One slow, rate-limited fetch shared by every caller: at most one run at a
 * time, and a result reused for `ttlMs`. Past that it is still served at
 * once while a fresh one is fetched in the background (stale while
 * revalidate), so no caller waits on gh after the first. A failed refresh
 * keeps the last good result.
 *
 * Why: `/api/prs` ran `gh pr list` for every configured repo on each
 * request, and every dashboard window asks every 2 minutes and on each
 * sessions change — about 6000 GitHub API points an hour with a few
 * busy sessions and two windows, past the 5000 limit, after which every
 * `gh` call failed (the PR watch then saw no PRs at all).
 */
export function createSharedFetch<T>(fetch: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  let last: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  const refresh = (): Promise<T> => {
    inFlight ??= fetch()
      .then((value) => {
        last = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    get(): Promise<T> {
      if (!last) return refresh();
      if (now() - last.at >= ttlMs) void refresh().catch(() => {}); // keep serving the last good one
      return Promise.resolve(last.value);
    },
    /** Forget the cached result (e.g. after creating a PR), so the next get fetches. */
    invalidate(): void {
      last = null;
    },
  };
}
