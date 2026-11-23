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
 * It is put right when the frame ends (the reprint is all there then); a repaint with no frame around it, once the
 * write it arrived in is parsed (`written`). The alternate screen (no scrollback) is left alone.
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

interface View {
  atBottom: boolean;
  /** Lines between the top of the view and the top of the screen (baseY − viewportY). */
  fromBottom: number;
  /** The text of the view's top lines; null when it's all blank or the view was at the bottom. */
  anchor: string[] | null;
  /** The scrollback was cleared (`CSI 3 J`): a repaint, not just a cleared screen. */
  repaint: boolean;
}

export class RepaintScroll {
  private inFrame = false;
  /** The view as it was at the first erase of this frame (or write), until the frame (or write) ends. */
  private view: View | null = null;
  private readonly hooks: Array<{ dispose(): void }>;

  constructor(private readonly term: RepaintTerminal) {
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
        return false;
      }),
    ];
  }

  /** A write was parsed: a repaint outside a synchronized frame is put right now. */
  written(): void {
    if (!this.inFrame) this.settle();
  }

  dispose(): void {
    for (const h of this.hooks) h.dispose();
  }

  private erase(scrollback: boolean): void {
    const b = this.term.buffer.active;
    if (b.type === 'alternate') return;
    if (!this.view) {
      const atBottom = b.viewportY >= b.baseY;
      this.view = { atBottom, fromBottom: b.baseY - b.viewportY, anchor: atBottom ? null : this.linesAt(b.viewportY), repaint: false };
    }
    if (scrollback) this.view.repaint = true;
  }

  private settle(): void {
    const view = this.view;
    this.view = null;
    if (!view?.repaint) return;
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
