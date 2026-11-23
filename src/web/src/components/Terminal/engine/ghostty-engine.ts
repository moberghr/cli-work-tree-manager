import { compileGhosttyAsync, instantiateGhosttyAsync } from '../../../../../core/pty/ghostty/wasm-core.js';
import { VtTerminal } from '../../../../../core/pty/ghostty/vt-terminal.js';
import { RenderState, type ColorState, type CursorState, type RowCells } from '../../../../../core/pty/ghostty/render-state.js';
import { encodeFocus, encodePaste, KeyEncoder } from '../../../../../core/pty/ghostty/key-encoder.js';
import { MouseEncoder, type MouseInput } from '../../../../../core/pty/ghostty/mouse-encoder.js';
import {
  SelectionGesture,
  clearSelection,
  extendSelection,
  hasSelection,
  hyperlinkAt,
  selectedText,
  type PointerAt,
} from '../../../../../core/pty/ghostty/pointer.js';
import { translateReplies } from '../../../../../core/pty/ghostty/replies.js';
import { VIEW_SCROLLBACK } from '../../../../../core/pty/scrollback.js';
import { themeRgb } from '../../../../../core/pty/terminal-colors.js';
import { onFontsSettled } from '../../../state/font-settle.js';
import { writeRich } from '../../../state/rich-copy.js';
import { markedOr, markedVt, terminalCopy } from '../../../state/terminal-copy.js';
import { boxShape, keyInput, rowRuns } from './ghostty-draw.js';
import { gridCell, heldButton, linkRun, mouseButton, urlAt, wheelButton, type LinkSpan } from './ghostty-pointer.js';
import {
  openLink,
  TERMINAL_FONT,
  TERMINAL_FONT_SIZE,
  type Disposable,
  type EngineOptions,
  type TerminalEngine,
} from './terminal-engine.js';

/**
 * libghostty-vt in the Terminal tab (terminal-rendering.md, "The Terminal tab's engines"): the same binding as the PTY
 * host's screen copy (src/core/pty/ghostty/), its module fetched as a served asset and compiled off the main thread,
 * drawn on one canvas. Each animation frame takes what changed from the render state and redraws only those rows —
 * backgrounds, then text by style, box and block characters as shapes — and the cursor; nothing is drawn while a
 * program holds the screen (synchronized output), for at most HOLD_MAX_MS. Keys go through libghostty's key encoder
 * (kitty, DECCKM, modifyOtherKeys as the program set them), pastes through its paste encoder. The pointer selects through
 * its selection gestures (Shift held while a program has the mouse), reports through its mouse encoder, and opens links
 * (OSC 8, and web addresses as xterm.js's WebLinksAddon finds them); a copy goes through terminal-copy.ts as xterm's does.
 */

/** The module, served next to the page (Vite copies it; the server knows its type). */
const WASM_URL = new URL('../../../../../../vendor/libghostty-vt/ghostty-vt-1.0.1.wasm', import.meta.url);
/** The longest a program may hold the screen (2026) before a frame is drawn anyway: xterm.js's 1 s. */
const HOLD_MAX_MS = 1000;
const BLINK_MS = 600;
/** The width FitAddon keeps for xterm.js's scrollbar: kept here too, so both engines fit the same grid (and the thumb is drawn in it). */
const SCROLLBAR_CSS = 14;
/** xterm.js's default selection: white at 30% over the cells' backgrounds, under their text. */
const SELECTION = 'rgba(255,255,255,0.3)';
/** How often a drag past the top or bottom edge scrolls the view a row. */
const AUTOSCROLL_MS = 50;

type Module = Awaited<ReturnType<typeof compileGhosttyAsync>>;
let compiled: Promise<Module> | null = null;

/** The module, fetched and compiled once per page; a failure is tried again next time. */
function ghosttyModule(): Promise<Module> {
  compiled ??= fetch(WASM_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} for the libghostty-vt module`);
      return r.arrayBuffer();
    })
    .then(compileGhosttyAsync);
  compiled.catch(() => {
    compiled = null;
  });
  return compiled;
}

/** A colour as CSS, each made once (a busy screen sets a fill style per run, every frame). */
const cssCache = new Map<number, string>();
const css = (rgb: number) => {
  let c = cssCache.get(rgb);
  if (c === undefined) {
    c = `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
    if (cssCache.size < 4096) cssCache.set(rgb, c);
  }
  return c;
};
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Metrics {
  dpr: number;
  /** A cell in device pixels. */
  cw: number;
  ch: number;
  /** The text's baseline from the cell's top. */
  baseline: number;
  fontPx: number;
  /** What the font advances per character, in device pixels: letter spacing makes it the cell's. */
  advance: number;
  /** A light line's width. */
  light: number;
}

function measureFont(dpr: number): Metrics {
  const ctx = document.createElement('canvas').getContext('2d');
  const fontPx = TERMINAL_FONT_SIZE * dpr;
  if (!ctx) throw new Error('no 2D canvas');
  ctx.font = `${fontPx}px ${TERMINAL_FONT}`;
  const m = ctx.measureText('W');
  const ascent = m.fontBoundingBoxAscent || fontPx * 0.8;
  const descent = m.fontBoundingBoxDescent || fontPx * 0.2;
  // Whole device pixels, as xterm.js's renderers make a cell: the same grid fits the pane.
  const cw = Math.max(1, Math.floor(m.width));
  const ch = Math.max(1, Math.ceil(ascent + descent));
  return {
    dpr,
    cw,
    ch,
    baseline: Math.round((ch - ascent - descent) / 2 + ascent),
    fontPx,
    advance: m.width,
    light: Math.max(1, Math.round(dpr)),
  };
}

const copyRow = (row: RowCells, into?: RowCells): RowCells => {
  if (!into || into.cols !== row.cols) {
    return {
      ...row,
      text: [...row.text],
      width: row.width.slice(),
      fg: row.fg.slice(),
      bg: row.bg.slice(),
      ul: row.ul.slice(),
      flags: row.flags.slice(),
      underline: row.underline.slice(),
      link: row.link.slice(),
    };
  }
  for (let i = 0; i < row.cols; i++) into.text[i] = row.text[i]!;
  into.width.set(row.width);
  into.fg.set(row.fg);
  into.bg.set(row.bg);
  into.ul.set(row.ul);
  into.flags.set(row.flags);
  into.underline.set(row.underline);
  into.link.set(row.link);
  into.wrapped = row.wrapped;
  into.selStart = row.selStart;
  into.selEnd = row.selEnd;
  return into;
};

const sameCursor = (a: CursorState | null, b: CursorState) =>
  !!a && a.x === b.x && a.y === b.y && a.visible === b.visible && a.style === b.style && a.blinking === b.blinking;

/** The engine, once its module is compiled and its terminal made (80 × 24 until PtyView sizes it). Rejects if it can't be. */
export async function createGhosttyEngine({ host, label, refit }: EngineOptions): Promise<TerminalEngine> {
  const instance = await instantiateGhosttyAsync(await ghosttyModule());
  const theme = themeRgb();
  // Replies (DA, DSR, colours…) as xterm.js would give them, sent after the write that asked (replies.ts).
  let replies: string[] = [];
  let held = false;
  let heldAt = 0;
  const t = VtTerminal.create(
    instance,
    80,
    24,
    // Grapheme clusters (2027) on, also after a reset: an emoji sequence is one character of two columns, as xterm.js's
    // Unicode 11 widths make it, and the PTY host's mirror has it.
    { scrollback: VIEW_SCROLLBACK, colors: theme, cursorBlink: true, graphemeClusters: true },
    {
      reply: (data) => replies.push(data),
      renderHold: (on) => {
        held = on;
        heldAt = performance.now();
        if (!on) schedule();
      },
    },
  );
  const rs = RenderState.create(t);
  const keys = KeyEncoder.create(t);
  const gesture = SelectionGesture.create(t);
  const mouse = MouseEncoder.create(t);

  // ---- the DOM: a box filling the pane, the canvas in it, a hidden textarea for the keyboard and input methods.
  const box = document.createElement('div');
  box.className = 'wd-ghostty';
  box.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;cursor:text;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;';
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'Terminal input');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.spellcheck = false;
  textarea.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;overflow:hidden;';
  box.append(canvas, textarea);
  host.append(box);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    box.remove();
    rs.free();
    keys.free();
    gesture.free();
    mouse.free();
    t.free();
    throw new Error('no 2D canvas');
  }
  label('ghostty');

  let m = measureFont(window.devicePixelRatio || 1);
  let colors: ColorState = rs.colors().colors;
  let snaps: RowCells[] = [];
  let cursor: CursorState | null = null;
  let focused = false;
  let visible = true;
  let blinkOn = true;
  let blink: ReturnType<typeof setInterval> | undefined;
  /** The link under the pointer (underlined, a pointer cursor), and rows to draw again next frame (it moved). */
  let hover: LinkSpan | null = null;
  const extra = new Set<number>();
  let fullNext = true;
  let cursorDirty = false;
  let raf = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dataListeners = new Set<(data: string) => void>();
  const renderListeners = new Set<() => void>();
  const fonts = new Map<number, string>();

  const emit = (data: string) => {
    if (data) for (const l of dataListeners) l(data);
  };
  const flushReplies = () => {
    if (!replies.length) return;
    const out = replies;
    replies = [];
    for (const r of out) for (const answer of translateReplies(r)) emit(answer);
  };
  /** Typed: the view goes back to the screen, as a terminal does, and a selection goes (xterm.js's onUserInput). */
  const typed = (data: string) => {
    if (!data) return;
    if (hasSelection(t)) {
      clearSelection(t);
      schedule();
    }
    if (!t.viewportActive()) {
      t.scrollViewport('bottom');
      fullNext = true;
      schedule();
    }
    emit(data);
  };

  const font = (bold: boolean, italic: boolean) => {
    const key = (bold ? 1 : 0) | (italic ? 2 : 0);
    let f = fonts.get(key);
    if (!f) {
      f = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${m.fontPx}px ${TERMINAL_FONT}`;
      fonts.set(key, f);
    }
    return f;
  };

  const sizeCanvas = () => {
    const gutter = Math.round(SCROLLBAR_CSS * m.dpr);
    const w = t.cols * m.cw + gutter;
    const h = t.rows * m.ch;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w / m.dpr}px`;
      canvas.style.height = `${h / m.dpr}px`;
    }
    // SGR pixel reports (1016) count in device pixels, as everything here does.
    mouse.resize({ width: w, height: h, cellWidth: m.cw, cellHeight: m.ch, paddingRight: gutter, paddingBottom: 0 });
    fullNext = true;
  };

  const paintRow = (y: number, cols: number) => {
    const row = snaps[y];
    const top = y * m.ch;
    const { cw, ch } = m;
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(colors.background);
    ctx.fillRect(0, top, cols * cw, ch);
    if (!row) return;
    const runs = rowRuns(row, { fg: colors.foreground, bg: colors.background });
    for (const b of runs.bgs) {
      ctx.fillStyle = css(b.color);
      ctx.fillRect(b.x * cw, top, b.cells * cw, ch);
    }
    if (row.selStart >= 0) {
      ctx.fillStyle = SELECTION;
      ctx.fillRect(row.selStart * cw, top, (row.selEnd - row.selStart + 1) * cw, ch);
    }
    for (const g of runs.boxes) {
      const shape = boxShape(g.cp, cw, ch, m.light);
      if (!shape) continue;
      ctx.globalAlpha = shape.alpha * (g.faint ? 0.5 : 1);
      ctx.fillStyle = css(g.color);
      for (const [x, yy, w, h] of shape.rects) ctx.fillRect(g.x * cw + x, top + yy, w, h);
      if (shape.strokes.length) {
        ctx.strokeStyle = css(g.color);
        ctx.lineWidth = shape.lineWidth;
        ctx.beginPath();
        for (const s of shape.strokes) {
          ctx.moveTo(g.x * cw + s.from[0], top + s.from[1]);
          if (s.via) ctx.quadraticCurveTo(g.x * cw + s.via[0], top + s.via[1], g.x * cw + s.to[0], top + s.to[1]);
          else ctx.lineTo(g.x * cw + s.to[0], top + s.to[1]);
        }
        ctx.stroke();
      }
    }
    ctx.textBaseline = 'alphabetic';
    // Letter spacing makes the font's advance the cell's: a run of narrow characters lands on its cells.
    ctx.letterSpacing = `${cw - m.advance}px`;
    for (const r of runs.texts) {
      ctx.globalAlpha = r.faint ? 0.5 : 1;
      ctx.fillStyle = css(r.color);
      ctx.font = font(r.bold, r.italic);
      for (const p of r.pieces) {
        const x = p.x * cw;
        // A run of plain narrow characters lands on its cells; anything else is one cell's character (a grapheme cluster
        // like 👍🏽 among them: one glyph), measured.
        const run = p.text.length > 1 && p.text.length === p.cells && p.text.charCodeAt(0) < 0x2000;
        if (!run) {
          const width = p.text.length === 1 && p.text.charCodeAt(0) < 0x2000 ? cw : ctx.measureText(p.text).width;
          if (width > p.cells * cw * 1.05) {
            // Wider than its cells (a fallback font's glyph): narrowed to them, as xterm.js's rescaleOverlappingGlyphs.
            ctx.save();
            ctx.translate(x, 0);
            ctx.scale((p.cells * cw) / width, 1);
            ctx.fillText(p.text, 0, top + m.baseline);
            ctx.restore();
            continue;
          }
        }
        ctx.fillText(p.text, x, top + m.baseline);
      }
      const lineColor = r.underlineColor === -1 ? r.color : r.underlineColor;
      const x0 = r.x * cw;
      const w = r.cells * cw;
      const lw = m.light;
      if (r.underline) {
        ctx.fillStyle = css(lineColor);
        const uy = Math.min(top + ch - lw, top + m.baseline + lw);
        if (r.underline === 1) ctx.fillRect(x0, uy, w, lw);
        else if (r.underline === 2) {
          ctx.fillRect(x0, uy - lw, w, lw);
          ctx.fillRect(x0, Math.min(top + ch - lw, uy + lw), w, lw);
        } else if (r.underline === 3) {
          ctx.strokeStyle = css(lineColor);
          ctx.lineWidth = lw;
          ctx.beginPath();
          const amp = Math.max(1, Math.round(lw * 1.5));
          for (let i = 0; i <= w; i += 2) ctx.lineTo(x0 + i, uy + Math.sin((i / cw) * Math.PI * 2) * amp);
          ctx.stroke();
        } else {
          const [on, off] = r.underline === 4 ? [lw, lw] : [lw * 3, lw * 2];
          for (let i = 0; i < w; i += on + off) ctx.fillRect(x0 + i, uy, Math.min(on, w - i), lw);
        }
      }
      ctx.fillStyle = css(r.color);
      if (r.strike) ctx.fillRect(x0, top + Math.round(ch / 2), w, lw);
      if (r.overline) ctx.fillRect(x0, top, w, lw);
    }
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
    // The link under the pointer, underlined (xterm.js underlines a link it hovers).
    if (hover) {
      ctx.fillStyle = css(colors.foreground);
      for (const c of hover.cells) {
        if (c.y === y) ctx.fillRect(c.x0 * cw, Math.min(top + ch - m.light, top + m.baseline + m.light), (c.x1 - c.x0 + 1) * cw, m.light);
      }
    }
  };

  const drawCursor = () => {
    const c = cursor;
    if (!c?.visible || c.y >= snaps.length) return;
    if (focused && c.blinking && !blinkOn) return;
    const row = snaps[c.y];
    const x = (c.wideTail ? c.x - 1 : c.x) * m.cw;
    const cells = row && row.width[c.wideTail ? c.x - 1 : c.x] === 2 ? 2 : 1;
    const top = c.y * m.ch;
    const w = cells * m.cw;
    const color = colors.cursor === -1 ? colors.foreground : colors.cursor;
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(color);
    ctx.strokeStyle = css(color);
    ctx.lineWidth = m.light;
    if (!focused || c.style === 'block_hollow') {
      ctx.strokeRect(x + m.light / 2, top + m.light / 2, w - m.light, m.ch - m.light);
    } else if (c.style === 'bar') ctx.fillRect(x, top, m.light * 2, m.ch);
    else if (c.style === 'underline') ctx.fillRect(x, top + m.ch - m.light * 2, w, m.light * 2);
    else {
      ctx.fillRect(x, top, w, m.ch);
      // The character under a block cursor, in the background's colour.
      const text = row?.text[c.wideTail ? c.x - 1 : c.x];
      if (text) {
        ctx.fillStyle = css(colors.background);
        ctx.font = font(false, false);
        ctx.fillText(text, x, top + m.baseline);
      }
    }
  };

  /** The scrollbar column: a thumb while the view is in the scrollback. */
  const drawScrollbar = () => {
    const gx = t.cols * m.cw;
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(colors.background);
    ctx.fillRect(gx, 0, canvas.width - gx, canvas.height);
    const s = t.scrollbar();
    if (s.total <= s.len || t.viewportActive()) return;
    const h = canvas.height;
    const thumb = Math.max(m.ch, Math.round((s.len / s.total) * h));
    const y = Math.round((s.offset / Math.max(1, s.total - s.len)) * (h - thumb));
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(gx + Math.round(m.dpr * 4), y, Math.round(m.dpr * 6), thumb);
  };

  /** The rows a frame redraws: one set, cleared each frame. */
  const repaint = new Set<number>();
  const frame = () => {
    raf = 0;
    if (disposed) return;
    if (held) {
      const wait = HOLD_MAX_MS - (performance.now() - heldAt);
      if (wait > 0) {
        holdTimer ??= setTimeout(() => {
          holdTimer = undefined;
          schedule();
        }, wait);
        return;
      }
    }
    const dirty = rs.update();
    const c = rs.colors();
    colors = c.colors;
    const rows = rs.rows;
    let all = fullNext || c.changed || dirty === 'full' || snaps.length !== rows;
    fullNext = false;
    if (snaps.length !== rows) snaps = snaps.slice(0, rows);
    repaint.clear();
    if (all || dirty !== 'none')
      rs.eachRow(all, (y, row) => {
        snaps[y] = copyRow(row, snaps[y]);
        repaint.add(y);
      });
    const next = rs.cursor();
    if (cursorDirty || !sameCursor(cursor, next)) {
      if (cursor && cursor.y < rows) repaint.add(cursor.y);
      repaint.add(next.y);
    }
    cursor = next;
    cursorDirty = false;
    rs.clean();
    if (canvas.width !== t.cols * m.cw + Math.round(SCROLLBAR_CSS * m.dpr) || canvas.height !== t.rows * m.ch) {
      sizeCanvas();
      all = true;
    }
    for (const y of extra) repaint.add(y);
    extra.clear();
    const cols = t.cols;
    if (all) for (let y = 0; y < rows; y++) paintRow(y, cols);
    else for (const y of repaint) if (y < rows) paintRow(y, cols);
    drawCursor();
    if (all) drawScrollbar();
    // The textarea follows the cursor: an input method's window opens there (set when it moves: a style write a frame costs a recalc).
    const left = `${(next.x * m.cw) / m.dpr}px`;
    const top = `${(next.y * m.ch) / m.dpr}px`;
    if (textarea.style.left !== left) textarea.style.left = left;
    if (textarea.style.top !== top) textarea.style.top = top;
    if (all || repaint.size) for (const l of renderListeners) l();
  };

  function schedule() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }

  /** The cursor blinks only while it is focused and shown: no timer otherwise. */
  const blinking = () => {
    const want = focused && visible && !disposed;
    if (want && !blink) {
      blink = setInterval(() => {
        blinkOn = !blinkOn;
        if (cursor?.visible && cursor.blinking) {
          cursorDirty = true;
          schedule();
        }
      }, BLINK_MS);
    } else if (!want && blink) {
      clearInterval(blink);
      blink = undefined;
      blinkOn = true;
    }
  };

  // ---- input
  const mac = isMac();
  // A copy, put back together (terminal-copy.ts) with its bold and italic, as xterm-engine's: Ctrl+C with a selection
  // (without one it stays an interrupt), and the browser's own copy (⌘C, Ctrl+Shift+C, a menu's Copy).
  const selected = () => {
    const s = selectedText(t);
    return s ? terminalCopy(markedOr(s.text, markedVt(s.vt)), t.cols, s.startX) : null;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey && hasSelection(t)) {
      e.preventDefault();
      const copy = selected();
      if (copy) void writeRich(copy).catch(() => {});
      clearSelection(t);
      schedule();
      return;
    }
    // Paste: left to the browser, whose paste event comes here (Ctrl+V, Shift+Insert, and ⌘ shortcuts on a Mac).
    if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert') || (mac && e.metaKey)) return;
    if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      t.scrollViewport((e.key === 'PageUp' ? -1 : 1) * Math.max(1, t.rows - 1));
      fullNext = true;
      schedule();
      return;
    }
    // Shift+Enter → newline in Claude's prompt (ESC CR, what Claude Code's /terminal-setup binds), as on xterm.js; a
    // program that asked for the kitty protocol gets the key as it asked.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !t.kittyKeyboardFlags()) {
      e.preventDefault();
      typed('\x1b\r');
      return;
    }
    const out = keys.encode(keyInput(e, mac));
    if (!out) return;
    e.preventDefault();
    blinkOn = true;
    typed(out);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    // Only a program that asked for key releases (kitty's flag) is sent one: the encoder says nothing otherwise.
    const out = keys.encode(keyInput(e, mac, 'release'));
    if (out) emit(out);
  };
  const onComposed = (e: CompositionEvent) => {
    if (e.data) typed(e.data);
    textarea.value = '';
  };
  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    // Text no key event sent (an emoji picker, dictation): sent as typed.
    if (!ev.isComposing && ev.inputType === 'insertText' && ev.data) typed(ev.data);
    if (!ev.isComposing) textarea.value = '';
  };
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return; // no text (an image): PtyView sends ^V for it
    e.preventDefault();
    typed(encodePaste(t, text));
  };
  const onCopy = (ev: ClipboardEvent) => {
    if (!ev.clipboardData || !hasSelection(t)) return;
    const copy = selected();
    if (!copy) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.clipboardData.setData('text/plain', copy.text);
    if (copy.html) ev.clipboardData.setData('text/html', copy.html);
  };
  const onFocus = () => {
    focused = true;
    blinkOn = true;
    blinking();
    cursorDirty = true;
    schedule();
    if (t.mode(1004)) emit(encodeFocus(t, true));
  };
  const onBlur = () => {
    focused = false;
    blinking();
    cursorDirty = true;
    schedule();
    if (t.mode(1004)) emit(encodeFocus(t, false));
  };
  let wheel = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // the browser's zoom
    e.preventDefault();
    wheel += e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * t.rows : (e.deltaY * m.dpr) / m.ch;
    const lines = Math.trunc(wheel);
    if (!lines) return;
    wheel -= lines;
    // A program that has the mouse gets the wheel as button 4 or 5, one report per wheel event that scrolls, as xterm.js
    // sends it (the program decides how far one goes); Shift scrolls the view instead.
    if (t.mouseTracking() && !e.shiftKey) {
      emit(mouse.encode(mouseInput(e, 'press', wheelButton(lines)), false));
      return;
    }
    if (t.screen() === 'alternate') {
      // No scrollback there: the wheel is the arrow keys, while the program leaves alternate scroll (1007) on.
      if (t.mode(1007)) {
        const code = lines < 0 ? 'ArrowUp' : 'ArrowDown';
        const arrow = keys.encode({ code, text: '', unshifted: 0, shift: false, ctrl: false, alt: false, meta: false });
        emit(arrow.repeat(Math.abs(lines)));
      }
      return;
    }
    t.scrollViewport(lines);
    fullNext = true;
    schedule();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault();
      textarea.focus();
    }
  };

  // ---- the pointer: reports to a program that has the mouse, else selection (and Shift selects in spite of it), links.
  /** A pointer event's place: in device pixels from the grid's corner (not clamped), and its cell (clamped). */
  const pointerAt = (e: MouseEvent): PointerAt => {
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * m.dpr;
    const py = (e.clientY - r.top) * m.dpr;
    return { px, py, cell: gridCell(px, py, m.cw, m.ch, t.cols, t.rows) };
  };
  const mouseInput = (e: MouseEvent, action: MouseInput['action'], button: number): MouseInput => {
    const p = pointerAt(e);
    return { action, button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, x: p.px, y: p.py };
  };
  const geometry = () => ({ cols: t.cols, cellWidth: m.cw, paddingLeft: 0, height: t.rows * m.ch });
  /** What a press started: a report to the program, a selection, or nothing. */
  let pressed: 'report' | 'select' | 'extend' | null = null;
  let last: PointerAt | null = null;
  let autoscroll: ReturnType<typeof setInterval> | undefined;
  const stopAutoscroll = () => {
    clearInterval(autoscroll);
    autoscroll = undefined;
  };
  const followAutoscroll = () => {
    if (gesture.autoscroll() === 'none') return stopAutoscroll();
    autoscroll ??= setInterval(() => {
      if (!last || gesture.autoscroll() === 'none') return stopAutoscroll();
      gesture.tick(last, geometry());
      fullNext = true;
      schedule();
    }, AUTOSCROLL_MS);
  };
  const setHover = (next: LinkSpan | null, title: string) => {
    if (next?.uri === hover?.uri && next?.cells[0]?.y === hover?.cells[0]?.y && next?.cells[0]?.x0 === hover?.cells[0]?.x0) return;
    for (const c of hover?.cells ?? []) extra.add(c.y);
    hover = next;
    for (const c of hover?.cells ?? []) extra.add(c.y);
    host.title = title;
    schedule();
  };
  /** The link under a cell: an OSC 8 one (its cells in the row), else a web address in the line's text. */
  const linkAt = (cell: { x: number; y: number }): { span: LinkSpan; osc8: boolean } | null => {
    const row = snaps[cell.y];
    if (!row) return null;
    const run = linkRun(row, cell.x);
    if (run) {
      const uri = hyperlinkAt(t, cell);
      if (uri) return { span: { uri, cells: [{ y: cell.y, ...run }] }, osc8: true };
    }
    const url = urlAt(snaps, cell);
    return url ? { span: url, osc8: false } : null;
  };
  const reportsMouse = (e: MouseEvent) => t.mouseTracking() && !e.shiftKey;
  const onPointerDown = (e: PointerEvent) => {
    const p = pointerAt(e);
    last = p;
    if (reportsMouse(e)) {
      const out = mouse.encode(mouseInput(e, 'press', mouseButton(e.button)), true);
      pressed = 'report';
      box.setPointerCapture(e.pointerId);
      emit(out);
      return;
    }
    if (e.button !== 0) return;
    box.setPointerCapture(e.pointerId);
    if (e.shiftKey && hasSelection(t)) {
      pressed = 'extend';
      extendSelection(t, p.cell);
    } else {
      pressed = 'select';
      gesture.press(p, e.timeStamp);
    }
    schedule();
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = pointerAt(e);
    last = p;
    if (pressed === 'report' || (!pressed && reportsMouse(e))) {
      box.style.cursor = 'default';
      setHover(null, '');
      emit(mouse.encode(mouseInput(e, 'motion', heldButton(e.buttons)), e.buttons !== 0));
      return;
    }
    if (pressed === 'select') {
      gesture.drag(p, geometry());
      followAutoscroll();
      schedule();
      return;
    }
    if (pressed === 'extend') {
      extendSelection(t, p.cell);
      schedule();
      return;
    }
    const link = linkAt(p.cell);
    setHover(link?.span ?? null, link?.osc8 ? link.span.uri : '');
    box.style.cursor = link ? 'pointer' : 'text';
  };
  const onPointerUp = (e: PointerEvent) => {
    const p = pointerAt(e);
    const was = pressed;
    pressed = null;
    stopAutoscroll();
    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    if (was === 'report') {
      emit(mouse.encode(mouseInput(e, 'release', mouseButton(e.button)), false));
      return;
    }
    if (was !== 'select') return;
    gesture.release(p);
    // A click (no drag) on a link opens it, as xterm.js's links do.
    if (e.type === 'pointerup' && !gesture.dragged() && gesture.clicks() === 1) {
      const link = linkAt(p.cell);
      if (link) openLink(link.span.uri);
    }
    schedule();
  };
  const onPointerLeave = () => {
    if (!pressed) setHover(null, '');
  };
  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('keyup', onKeyUp);
  textarea.addEventListener('compositionend', onComposed);
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('paste', onPaste);
  textarea.addEventListener('focus', onFocus);
  textarea.addEventListener('blur', onBlur);
  box.addEventListener('wheel', onWheel, { passive: false });
  box.addEventListener('mousedown', onMouseDown);
  box.addEventListener('pointerdown', onPointerDown);
  box.addEventListener('pointermove', onPointerMove);
  box.addEventListener('pointerup', onPointerUp);
  box.addEventListener('pointercancel', onPointerUp);
  box.addEventListener('pointerleave', onPointerLeave);
  box.addEventListener('copy', onCopy, true);
  // For tests (e2e/ghostty-terminal.spec.ts): the rows on screen as last drawn, one line each (a wide character's tail
  // cell left out) — a canvas has no text to read.
  Object.defineProperty(box, 'wdScreenText', {
    value: () =>
      snaps
        .map((r) =>
          r.text
            .map((c, x) => (r.width[x] === 0 ? '' : c || ' '))
            .join('')
            .trimEnd(),
        )
        .join('\n'),
  });

  // A font of the stack that arrives later: the cell measured again, everything redrawn, the grid fitted.
  const remeasure = () => {
    m = measureFont(window.devicePixelRatio || 1);
    fonts.clear();
    sizeCanvas();
    schedule();
  };
  const stopFonts = onFontsSettled(
    document.fonts,
    () => TERMINAL_FONT,
    () => {
      remeasure();
      refit();
    },
  );
  sizeCanvas();
  schedule();

  const write = (data: string | Uint8Array, done?: () => void) => {
    if (disposed) return;
    if (typeof data === 'string') t.write(data);
    else t.writeBytes(data);
    flushReplies();
    schedule();
    // Parsed now; `done` after this task, as xterm.js calls it (never inside the write).
    if (done) queueMicrotask(done);
  };
  const resize = (cols: number, rows: number) => {
    if (cols === t.cols && rows === t.rows) return;
    t.resize(cols, rows);
    sizeCanvas();
    schedule();
  };

  return {
    kind: 'ghostty',
    get cols() {
      return t.cols;
    },
    get rows() {
      return t.rows;
    },
    textarea,
    write,
    writeOutput: (data, done) => write(data, done),
    resize,
    // libghostty keeps a view scrolled up on its rows through a reflow, and one at the bottom there.
    resizeKeepingView: resize,
    proposeDimensions() {
      if ((window.devicePixelRatio || 1) !== m.dpr) remeasure();
      const style = getComputedStyle(host);
      const width = parseInt(style.getPropertyValue('width')) - SCROLLBAR_CSS;
      const height = parseInt(style.getPropertyValue('height'));
      if (!(width > 0) || !(height > 0)) return undefined;
      return { cols: Math.max(2, Math.floor((width * m.dpr) / m.cw)), rows: Math.max(1, Math.floor((height * m.dpr) / m.ch)) };
    },
    focus: () => textarea.focus({ preventScroll: true }),
    scrollToBottom() {
      t.scrollViewport('bottom');
      fullNext = true;
      schedule();
    },
    // ConPTY reflows its lines itself; libghostty reflows too (no switch to stop it): a known difference.
    setWindowsPty() {},
    onData(listener): Disposable {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onRender(listener): Disposable {
      renderListeners.add(listener);
      return { dispose: () => renderListeners.delete(listener) };
    },
    shown() {
      visible = true;
      blinking();
      fullNext = true;
      schedule();
    },
    hidden() {
      visible = false;
      blinking();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
      clearInterval(blink);
      stopAutoscroll();
      stopFonts();
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('keyup', onKeyUp);
      textarea.removeEventListener('compositionend', onComposed);
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('paste', onPaste);
      textarea.removeEventListener('focus', onFocus);
      textarea.removeEventListener('blur', onBlur);
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('mousedown', onMouseDown);
      box.removeEventListener('pointerdown', onPointerDown);
      box.removeEventListener('pointermove', onPointerMove);
      box.removeEventListener('pointerup', onPointerUp);
      box.removeEventListener('pointercancel', onPointerUp);
      box.removeEventListener('pointerleave', onPointerLeave);
      box.removeEventListener('copy', onCopy, true);
      box.remove();
      dataListeners.clear();
      renderListeners.clear();
      keys.free();
      gesture.free();
      mouse.free();
      rs.free();
      t.free();
    },
  };
}
