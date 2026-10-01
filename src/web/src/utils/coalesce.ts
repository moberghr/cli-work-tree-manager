/**
 * Collapse a burst of triggers into few runs of `fn`: it runs `waitMs`
 * after the FIRST trigger of a burst (later ones don't push it back), never
 * twice at once, and once more after a run if triggers arrived while it was
 * going. So a change is on screen within `waitMs` plus one fetch, however
 * busy things are — a debounce (wait for the burst to settle) kept the
 * session list stale for as long as any Claude kept writing.
 *
 * For refetches driven by server events: `sessions-changed` fires every
 * 250 ms while any Claude is writing its transcript, and refetching the
 * whole session list on each one (per open tab) kept the server busy
 * rebuilding it.
 */
export function coalesce(fn: () => Promise<unknown>, waitMs: number): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let cancelled = false;

  const run = async () => {
    timer = null;
    if (cancelled) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fn();
    } catch {
      /* the caller's fn handles its own errors */
    } finally {
      running = false;
      if (again && !cancelled) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (timer) return; // already coming: it will see this change too
    timer = setTimeout(() => void run(), waitMs);
  };
  return {
    trigger: () => {
      if (cancelled) return;
      if (running) again = true;
      else schedule();
    },
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}
