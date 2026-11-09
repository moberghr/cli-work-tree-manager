/**
 * The page's asks to the desktop app go out one at a time. An ask is a navigation the app
 * cancels (use-desktop.ts ASK_URL); two started in the same task can replace each other in
 * the WebView before the app sees the first (`hello` with a `badge/…` on load, a count with
 * `attention`). The first goes at once; the rest follow, ASK_GAP_MS apart, in order.
 */
export const ASK_GAP_MS = 50;

type Go = (url: string) => void;

export function createAskQueue(schedule: (fn: () => void) => void = (fn) => void setTimeout(fn, ASK_GAP_MS)) {
  const queue: Array<{ url: string; go: Go }> = [];
  let busy = false;
  const next = () => {
    const item = queue.shift();
    if (!item) {
      busy = false;
      return;
    }
    busy = true;
    item.go(item.url);
    schedule(next);
  };
  return (url: string, go: Go): void => {
    queue.push({ url, go });
    if (!busy) next();
  };
}

/** The page's one queue: every hook that asks the app goes through it. */
export const sendDesktopAsk = createAskQueue();
