/**
 * The Terminal tab's WebGL renderer over its life (terminal-rendering.md, "Fonts and the renderer"): loaded where it
 * may be (webgl-gate.ts), dropped for the DOM renderer when its context is lost and tried again after a pause
 * (webgl-recovery.ts), let go while the terminal is hidden in the deck and made again when it is shown.
 *
 * - **Hidden.** Browsers cap live WebGL contexts (Chromium 16 a page process) and take the oldest one away when a new
 *   one goes past the cap: a context loss on a terminal you may come back to. A terminal hidden for WEBGL_RELEASE_MS
 *   lets its context go; its buffer stays, and the DOM renderer keeps it drawn (unseen). Shown again, it gets a new
 *   one before it is fitted, so the grid is measured with the renderer that draws it.
 * - **Lost.** A try again that falls due while the terminal is hidden waits until it is shown: one try then, not one
 *   per pause behind your back.
 * - **Let go for real.** `@xterm/addon-webgl` 0.19 removes its canvas on dispose but never loses the context, which
 *   then counts against the cap until the canvas is garbage-collected. Every dispose here loses it too (Hermes does
 *   the same, web/src/lib/xterm-webgl-release.ts): a tab that reconnects again and again otherwise walks into the cap
 *   and takes the context of the terminal you are looking at.
 *
 * No xterm import: the addon and the terminal come through `WebglHost`, so this is tested with fakes.
 */
import { WebglRecovery } from './webgl-recovery.js';

/** A hidden terminal keeps its context this long, so flipping between sessions doesn't make one per flip. */
export const WEBGL_RELEASE_MS = 10_000;

/** Which renderer draws: 'retrying' is the DOM one after a lost context, WebGL to be tried again; 'dom' for good. */
export type RendererKind = 'webgl' | 'retrying' | 'dom';

export interface WebglAddonLike {
  onContextLoss(cb: () => void): unknown;
  dispose(): void;
}

export interface WebglHost<A extends WebglAddonLike> {
  /** A new addon. May throw (no WebGL2). */
  create(): A;
  /** Loads it into the terminal. May throw (no context to be had). */
  load(addon: A): void;
  /** The canvases under the terminal now: the addon's are the ones its dispose takes out. */
  canvases(): Iterable<HTMLCanvasElement>;
  /** The renderer changed: the corner says it. */
  label(kind: RendererKind): void;
  /** The renderer changed while shown: the two measure a cell differently, so fit again. */
  refit(): void;
}

export interface WebglTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: WebglTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Loses the WebGL context of each canvas that has one; a 2D canvas or one with no context is left alone. */
export function loseContexts(canvases: Iterable<HTMLCanvasElement>): number {
  let lost = 0;
  for (const canvas of canvases) {
    // Asking a canvas for the kind of context it holds returns that one; for any other kind, null (none is made).
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext && !gl?.isContextLost()) {
      ext.loseContext();
      lost += 1;
    }
  }
  return lost;
}

export class WebglRenderer<A extends WebglAddonLike> {
  private addon: A | null = null;
  private retry: unknown = null;
  private release: unknown = null;
  /** Once a context was had here, a load that fails is a loss (try again), not "no WebGL here". */
  private hadContext = false;
  /** On the DOM renderer for good: refused here, never available, or lost too often. */
  private settled = false;
  private disposed = false;
  private readonly recovery = new WebglRecovery();

  constructor(
    private readonly host: WebglHost<A>,
    private visible: boolean,
    refusal: string | null,
    private readonly timers: WebglTimers = browserTimers,
    private readonly releaseMs = WEBGL_RELEASE_MS,
  ) {
    if (refusal) this.stayOnDom();
    else if (visible) this.load(false);
    // Hidden from the start: nothing to draw for anyone, so no context until shown.
  }

  /** On screen: its context is kept, or made again when it was let go. Call before fitting. */
  shown(): void {
    this.visible = true;
    this.cancelRelease();
    if (!this.addon && !this.settled && this.retry === null && !this.disposed) this.load(false);
  }

  /** Hidden in the deck: its context goes after WEBGL_RELEASE_MS unless shown again before. */
  hidden(): void {
    this.visible = false;
    if (!this.addon || this.release !== null) return;
    this.release = this.timers.set(() => {
      this.release = null;
      if (!this.visible) this.drop();
    }, this.releaseMs);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRelease();
    if (this.retry !== null) this.timers.clear(this.retry);
    this.retry = null;
    this.drop();
  }

  /** `refit`: the DOM renderer was drawing on screen until now (a try again), and nothing else fits after this. */
  private load(refit: boolean): void {
    let addon: A | null = null;
    try {
      addon = this.host.create();
      const loaded = addon;
      addon.onContextLoss(() => {
        if (this.addon === loaded) this.lost();
      });
      this.host.load(addon);
      this.addon = addon;
      this.hadContext = true;
      this.host.label('webgl');
      if (refit) this.host.refit();
    } catch {
      // xterm registers an addon before activating it: one whose activate threw stays attached unless disposed.
      try {
        addon?.dispose();
      } catch {
        /* half-built */
      }
      if (this.hadContext) this.lost();
      else this.stayOnDom(); // no WebGL here at all: nothing to wait for
    }
  }

  /** The context was lost (or a try again failed): the DOM renderer, and a try again after a pause or never. */
  private lost(): void {
    this.drop();
    const wait = this.recovery.lost(this.timers.now());
    if (wait === null) {
      this.stayOnDom();
    } else {
      this.host.label('retrying');
      this.retry = this.timers.set(() => {
        this.retry = null;
        // Hidden: the try waits for the terminal to be shown (shown()).
        if (this.visible && !this.disposed) this.load(true);
      }, wait);
    }
    if (this.visible) this.host.refit();
  }

  private stayOnDom(): void {
    this.settled = true;
    this.host.label('dom');
  }

  /** The addon disposed (xterm goes back to the DOM renderer) and its context lost. */
  private drop(): void {
    this.cancelRelease();
    const addon = this.addon;
    if (!addon) return;
    this.addon = null;
    const before = [...this.host.canvases()];
    try {
      addon.dispose();
    } catch {
      /* already gone with its terminal */
    }
    loseContexts(before.filter((c) => !c.isConnected));
  }

  private cancelRelease(): void {
    if (this.release !== null) this.timers.clear(this.release);
    this.release = null;
  }
}
