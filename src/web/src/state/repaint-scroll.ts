/**
 * Keeping the view where it was through an agent's repaint (terminal-rendering.md "Scroll after a repaint"). An agent
 * that reprints its whole transcript — Claude Code after a resize or a toggle — writes `CSI 2 J` `CSI 3 J` (clear the
 * screen and the scrollback) and then every line again, in one synchronized frame (DEC 2026). xterm.js keeps a view at
 * the bottom there, but a view scrolled up lands at the top of the new scrollback and stops following: you were reading
 * line 400 of 500 and are shown line 1.
 *
 * Followed with xterm's public parser hooks (handlers registered later run first, and returning false lets xterm's own
 * run), so the view is noted BEFORE xterm clears anything:
 * - at the bottom → kept at the bottom (xterm does it already; this makes sure, as Wave Terminal does);
 * - scrolled up → the same text at the top of the view: the lines that were there are looked for in the reprint,
 *   nearest to the same distance from the bottom; if they are not in it, that distance alone.
 * It is put right when the frame ends (the reprint is all there then). A repaint with no frame around it comes in several
 * writes (the PTY is read 1 KiB at a time, and the first read of a quiet moment is sent alone): it is placed after each
 * write as far as the reprint has come (`written`), and put right for good once no write has come for REPAINT_QUIET_MS,
 * or REPAINT_SETTLE_MS after it began, whichever is first — so output that goes on after it never holds the view. The
 * alternate screen (no scrollback) is left alone.
 */
import { SYNC_MODE } from '../../../core/pty/sync-output.js';

/** The part of xterm.js's Terminal used here (public API). */
export interface RepaintTerminal {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type?: 'normal' | 'alternate';
      readonly viewportY: number;
      readonly baseY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  readonly parser: {
    registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void };
    registerEscHandler(id: { final: string }, callback: () => boolean): { dispose(): void };
  };
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

/** How many lines from the top of the view are looked for in the reprint (one alone is often a blank or a rule). */
const ANCHOR_LINES = 3;

/**
 * A repaint with no frame around it is over once no write has come for this long. Its writes come within a few ms of
 * each other (a 400 KiB reprint arrives in 6 to 8 ms, terminal-rendering.md "Synchronized output").
 */
export const REPAINT_QUIET_MS = 50;
/** …and is put right for good at the latest this long after it began, if output goes on: the view is yours again. */
export const REPAINT_SETTLE_MS = 500;

/** A clock and timers (the page's by default; a test's by hand). */
export interface RepaintTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const pageTimers: RepaintTimers = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

interface View {
  atBottom: boolean;
  /** Lines between the top of the view and the top of the screen (baseY − viewportY). */
  fromBottom: number;
  /** The text of the view's top lines; null when it's all blank or the view was at the bottom. */
  anchor: string[] | null;
  /** The scrollback was cleared (`CSI 3 J`): a repaint, not just a cleared screen. */
  repaint: boolean;
  /** When it was noted (the first erase). */
  since: number;
}

export class RepaintScroll {
  private inFrame = false;
  /** The view as it was at the first erase of this frame (or write), until the frame (or write) ends. */
  private view: View | null = null;
  private readonly hooks: Array<{ dispose(): void }>;
  /** A repaint with no frame around it: put right for good when this fires (REPAINT_QUIET_MS after its last write). */
  private quiet: unknown = null;

  constructor(
    private readonly term: RepaintTerminal,
    private readonly timers: RepaintTimers = pageTimers,
  ) {
    const sync = (params: (number | number[])[]) => params.some((p) => (Array.isArray(p) ? p[0] : p) === SYNC_MODE);
    this.hooks = [
      term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        const mode = params[0];
        if (mode === 2 || mode === 3) this.erase(mode === 3);
        return false;
      }),
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (sync(params)) this.inFrame = true;
        return false;
      }),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (sync(params) && this.inFrame) {
          this.inFrame = false;
          this.settle();
        }
        return false;
      }),
      // RIS (a catch-up's reset, PtyView): everything is gone, the frame too.
      term.parser.registerEscHandler({ final: 'c' }, () => {
        this.inFrame = false;
        this.view = null;
        if (this.quiet !== null) this.timers.clear(this.quiet);
        this.quiet = null;
        return false;
      }),
    ];
  }

  /**
   * A write was parsed. A repaint outside a synchronized frame may go on in the next write: placed as far as it has come,
   * and put right for good once the writes stop (REPAINT_QUIET_MS), or REPAINT_SETTLE_MS after it began.
   */
  written(): void {
    const view = this.view;
    if (this.inFrame || !view) return;
    if (this.timers.now() - view.since >= REPAINT_SETTLE_MS) return this.settle();
    this.place(view);
    if (this.quiet !== null) this.timers.clear(this.quiet);
    this.quiet = this.timers.set(() => {
      this.quiet = null;
      if (!this.inFrame) this.settle();
    }, REPAINT_QUIET_MS);
  }

  dispose(): void {
    for (const h of this.hooks) h.dispose();
    if (this.quiet !== null) this.timers.clear(this.quiet);
    this.quiet = null;
  }

  private erase(scrollback: boolean): void {
    const b = this.term.buffer.active;
    if (b.type === 'alternate') return;
    if (!this.view) {
      const atBottom = b.viewportY >= b.baseY;
      this.view = {
        atBottom,
        fromBottom: b.baseY - b.viewportY,
        anchor: atBottom ? null : this.linesAt(b.viewportY),
        repaint: false,
        since: this.timers.now(),
      };
    }
    if (scrollback) this.view.repaint = true;
  }

  private settle(): void {
    const view = this.view;
    this.view = null;
    if (this.quiet !== null) this.timers.clear(this.quiet);
    this.quiet = null;
    if (view) this.place(view);
  }

  /** The view where it belongs in the reprint as it stands. Nothing for a cleared screen alone (no `CSI 3 J`). */
  private place(view: View): void {
    if (!view.repaint) return;
    if (view.atBottom) {
      this.term.scrollToBottom();
      return;
    }
    const baseY = this.term.buffer.active.baseY;
    const estimate = Math.max(0, Math.min(baseY, baseY - view.fromBottom));
    this.term.scrollToLine((view.anchor && this.find(view.anchor, estimate, baseY)) ?? estimate);
  }

  /** The text of ANCHOR_LINES lines from `y`; null if all blank. */
  private linesAt(y: number): string[] | null {
    const lines: string[] = [];
    for (let i = 0; i < ANCHOR_LINES; i++) lines.push(this.term.buffer.active.getLine(y + i)?.translateToString(true) ?? '');
    return lines.some((l) => l.trim()) ? lines : null;
  }

  /** Where `anchor` starts in the buffer, nearest to `from` (a view's top: 0 to `baseY`); null if nowhere. */
  private find(anchor: string[], from: number, baseY: number): number | null {
    const at = (y: number) => {
      for (let i = 0; i < anchor.length; i++)
        if ((this.term.buffer.active.getLine(y + i)?.translateToString(true) ?? '') !== anchor[i]) return false;
      return true;
    };
    for (let d = 0; d <= baseY; d++) {
      if (from - d >= 0 && at(from - d)) return from - d;
      if (d && from + d <= baseY && at(from + d)) return from + d;
    }
    return null;
  }
}
