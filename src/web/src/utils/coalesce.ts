/**
 * Collapse a burst of triggers into few runs of `fn`: it runs `waitMs`
 * after the last trigger, never twice at once, and once more after a run if
 * triggers arrived while it was going.
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
    if (timer) clearTimeout(timer);
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
