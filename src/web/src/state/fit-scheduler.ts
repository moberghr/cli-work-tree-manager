/**
 * When the Terminal tab fits its grid to its pane (terminal-rendering.md, "Resizing and attaching at a size").
 *
 * Dragging the window or the rail divider fires the pane's ResizeObserver every frame. Each fit that changes the grid
 * resizes the PTY, and the agent (a full-screen TUI) repaints for each size: a resize per frame left garbage and
 * flicker. So a fit runs at most once per FIT_MIN_MS: the first of a burst at once, the rest as one at the end of the
 * window, which measures the pane as it is then, so the last size always lands.
 *
 * Every fit runs in a task of its own, never inside the observer's callback: that callback runs after the frame's
 * animation callbacks and right before its paint, and the WebGL renderer clears its canvas on a resize and draws it
 * again only in the next frame's animation callback, so a fit there showed one blank frame (measured, xterm.js 6.0 +
 * addon-webgl 0.19 in Chromium). From a task, the renderer's draw comes before the next paint.
 */

/**
 * At most one fit per 50 ms. Tabby caps its reflows at one per frame with a 32 ms floor, for its own renderer; Theia
 * waits 50 ms before it resizes the terminal and its process; Codex waits 75 ms before it reflows. Here each fit can
 * cost the agent a whole repaint, which comes back over the host and a WebSocket (an echo takes 6–18 ms): 50 ms lets
 * one land before the next size goes, and still follows a drag.
 */
export const FIT_MIN_MS = 50;

export interface FitTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: FitTimers = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `fit` when asked (`request`), at most once per `minMs`, always once after the last request. */
export class FitScheduler {
  private last = -Infinity;
  private pending: unknown = null;

  constructor(
    private readonly fit: () => void,
    private readonly timers: FitTimers = browserTimers,
    private readonly minMs = FIT_MIN_MS,
  ) {}

  /** The pane may have changed size: fit soon (in a task of its own), or at the end of the current window. */
  request(): void {
    if (this.pending !== null) return;
    const wait = Math.max(0, this.last + this.minMs - this.timers.now());
    this.pending = this.timers.set(() => {
      this.pending = null;
      this.last = this.timers.now();
      this.fit();
    }, wait);
  }

  dispose(): void {
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = null;
  }
}
