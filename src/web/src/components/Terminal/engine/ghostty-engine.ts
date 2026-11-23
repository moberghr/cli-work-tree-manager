import { compileGhosttyAsync, instantiateGhosttyAsync } from '../../../../../core/pty/ghostty/wasm-core.js';
import { VtTerminal } from '../../../../../core/pty/ghostty/vt-terminal.js';
import { RenderState, type ColorState, type CursorState, type RowCells } from '../../../../../core/pty/ghostty/render-state.js';
import { encodeFocus, encodePaste, KeyEncoder } from '../../../../../core/pty/ghostty/key-encoder.js';
import { translateReplies } from '../../../../../core/pty/ghostty/replies.js';
import { VIEW_SCROLLBACK } from '../../../../../core/pty/scrollback.js';
import { themeRgb } from '../../../../../core/pty/terminal-colors.js';
import { onFontsSettled } from '../../../state/font-settle.js';
import { boxShape, keyInput, rowRuns } from './ghostty-draw.js';
import { TERMINAL_FONT, TERMINAL_FONT_SIZE, type Disposable, type EngineOptions, type TerminalEngine } from './terminal-engine.js';

/**
 * libghostty-vt in the Terminal tab (terminal-rendering.md, "The Terminal tab's engines"): the same binding as the PTY
 * host's screen copy (src/core/pty/ghostty/), its module fetched as a served asset and compiled off the main thread,
 * drawn on one canvas. Each animation frame takes what changed from the render state and redraws only those rows —
 * backgrounds, then text by style, box and block characters as shapes — and the cursor; nothing is drawn while a
 * program holds the screen (synchronized output), for at most HOLD_MAX_MS. Keys go through libghostty's key encoder
 * (kitty, DECCKM, modifyOtherKeys as the program set them), pastes through its paste encoder.
 */

/** The module, served next to the page (Vite copies it; the server knows its type). */
const WASM_URL = new URL('../../../../../../vendor/libghostty-vt/ghostty-vt-1.0.1.wasm', import.meta.url);
/** The longest a program may hold the screen (2026) before a frame is drawn anyway: xterm.js's 1 s. */
const HOLD_MAX_MS = 1000;
const BLINK_MS = 600;
/** The width FitAddon keeps for xterm.js's scrollbar: kept here too, so both engines fit the same grid (and the thumb is drawn in it). */
const SCROLLBAR_CSS = 14;

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

const css = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
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
    };
  }
  for (let i = 0; i < row.cols; i++) into.text[i] = row.text[i]!;
  into.width.set(row.width);
  into.fg.set(row.fg);
  into.bg.set(row.bg);
  into.ul.set(row.ul);
  into.flags.set(row.flags);
  into.underline.set(row.underline);
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
    { scrollback: VIEW_SCROLLBACK, colors: theme, cursorBlink: true },
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
    t.free();
    throw new Error('no 2D canvas');
  }
  label('ghostty');

  let m = measureFont(window.devicePixelRatio || 1);
  let colors: ColorState = rs.colors().colors;
  let snaps: RowCells[] = [];
  let cursor: CursorState | null = null;
  let focused = false;
  let blinkOn = true;
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
  /** Typed: the view goes back to the screen, as a terminal does. */
  const typed = (data: string) => {
    if (!data) return;
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
    fullNext = true;
  };

  const paintRow = (y: number) => {
    const row = snaps[y];
    const top = y * m.ch;
    const { cw, ch } = m;
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(colors.background);
    ctx.fillRect(0, top, t.cols * cw, ch);
    if (!row) return;
    const runs = rowRuns(row, { fg: colors.foreground, bg: colors.background });
    for (const b of runs.bgs) {
      ctx.fillStyle = css(b.color);
      ctx.fillRect(b.x * cw, top, b.cells * cw, ch);
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
        if (p.text.length === 1 || p.cells === p.text.length) {
          const width = p.text.length === 1 && p.text.charCodeAt(0) < 0x2000 ? cw : ctx.measureText(p.text).width;
          if (width > p.cells * cw * 1.05 && p.text.length <= 2) {
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
    const repaint = new Set<number>();
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
    if (all) for (let y = 0; y < rows; y++) paintRow(y);
    else for (const y of repaint) if (y < rows) paintRow(y);
    drawCursor();
    if (all) drawScrollbar();
    // The textarea follows the cursor: an input method's window opens there.
    textarea.style.left = `${(next.x * m.cw) / m.dpr}px`;
    textarea.style.top = `${(next.y * m.ch) / m.dpr}px`;
    if (all || repaint.size) for (const l of renderListeners) l();
  };

  function schedule() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }

  const blink = setInterval(() => {
    blinkOn = !blinkOn;
    if (focused && cursor?.visible && cursor.blinking) {
      cursorDirty = true;
      schedule();
    }
  }, BLINK_MS);

  // ---- input
  const mac = isMac();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
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
  const onFocus = () => {
    focused = true;
    blinkOn = true;
    cursorDirty = true;
    schedule();
    if (t.mode(1004)) emit(encodeFocus(t, true));
  };
  const onBlur = () => {
    focused = false;
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
    if (t.screen() === 'alternate') {
      // No scrollback there: the wheel is the arrow keys, as xterm.js does (mouse reporting is not drawn here yet).
      if (!t.mouseTracking()) {
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
  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('keyup', onKeyUp);
  textarea.addEventListener('compositionend', onComposed);
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('paste', onPaste);
  textarea.addEventListener('focus', onFocus);
  textarea.addEventListener('blur', onBlur);
  box.addEventListener('wheel', onWheel, { passive: false });
  box.addEventListener('mousedown', onMouseDown);

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
      fullNext = true;
      schedule();
    },
    hidden() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
      clearInterval(blink);
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
      box.remove();
      dataListeners.clear();
      renderListeners.clear();
      keys.free();
      rs.free();
      t.free();
    },
  };
}
