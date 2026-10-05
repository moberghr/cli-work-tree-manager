/**
 * When the Terminal tab tries the GPU renderer again after losing it. A
 * WebGL context is lost on a GPU reset — sleep and resume, a driver update,
 * the browser reclaiming contexts — and xterm then draws with the DOM
 * renderer, which is what makes a busy Claude feel sluggish. Before, the
 * terminal stayed on it until a reload. Now it tries again after a pause,
 * longer each time, and stops when the context keeps getting lost (a GPU
 * that can't hold one isn't helped by more tries). Pure (times passed in).
 */

/** The pause before each try again: after the first loss, the second, the third. */
export const WEBGL_RETRY_MS = [2_000, 10_000, 60_000] as const;
/** Losses older than this are forgotten: a reset once a day always recovers. */
export const WEBGL_LOSS_WINDOW_MS = 10 * 60_000;

export class WebglRecovery {
  private losses: number[] = [];

  /** The context was lost at `now`: how long to wait before trying again, or null to stay on the DOM renderer. */
  lost(now: number): number | null {
    this.losses = this.losses.filter((t) => now - t < WEBGL_LOSS_WINDOW_MS);
    this.losses.push(now);
    return WEBGL_RETRY_MS[this.losses.length - 1] ?? null;
  }
}
