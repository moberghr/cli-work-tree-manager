import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { VIEW_SCROLLBACK } from '../../../../../core/pty/scrollback.js';
import { TERMINAL_THEME } from '../../../../../core/pty/terminal-colors.js';
import type { WindowsPty } from '../../../../../core/pty/terminal-size.js';
import { WebglRenderer } from '../../../state/webgl-renderer.js';
import { pageWebglRefusal } from '../../../state/webgl-gate.js';
import { onFontsSettled } from '../../../state/font-settle.js';
import { selectionText, terminalCopy } from '../../../state/terminal-copy.js';
import { writeRich } from '../../../state/rich-copy.js';
import { RepaintScroll } from '../../../state/repaint-scroll.js';
import { TERMINAL_FONT, TERMINAL_FONT_SIZE, type Disposable, type EngineOptions, type TerminalEngine } from './terminal-engine.js';
import '@xterm/xterm/css/xterm.css';

/** Open a link from the terminal: web addresses only, in a new tab (the
 *  desktop app hands those to the default browser). */
export function openLink(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  window.open(uri, '_blank', 'noopener');
}

/** xterm.js: the Terminal tab's default engine, with its WebGL renderer, its fonts, copy and links. */
export function createXtermEngine({ host, active, label, refit }: EngineOptions): TerminalEngine {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: TERMINAL_FONT_SIZE,
    fontFamily: TERMINAL_FONT,
    // The PTY host answers an agent's colour query with these when no tab is open to (core/pty/terminal-colors.ts).
    theme: TERMINAL_THEME,
    convertEol: false,
    // Kept while connected; a reattach brings back the PTY host's REPLAY_SCROLLBACK (core/pty/scrollback.ts).
    scrollback: VIEW_SCROLLBACK,
    // Required by the unicode11 addon (proposed API in xterm 6).
    allowProposedApi: true,
    // Block and box glyphs drawn to the cell by xterm, not taken from the font: Claude Code's logo and its boxes stay
    // whole (with the font's glyphs they show gaps between cells). A glyph wider than its one cell (Ⅻ) is narrowed
    // to it rather than drawn over the next. minimumContrastRatio stays 1: the agent's colours as it sent them.
    // Measured: terminal-rendering.md, "Fonts and the renderer".
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    // Links Claude prints as terminal hyperlinks (OSC 8). xterm's default
    // asks "could be dangerous?" and then opens a BLANK window it navigates
    // afterwards — the desktop app only sees about:blank and opens nothing.
    // Open the real address instead, web links only; hovering shows where
    // it goes (the text of such a link can differ from its target).
    linkHandler: {
      activate: (_e, uri) => openLink(uri),
      hover: (_e, uri) => {
        host.title = uri;
      },
      leave: () => {
        host.title = '';
      },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Claude's UI is full of emoji / box-drawing / spinner glyphs; xterm's
  // default Unicode 6 width table mis-measures many of them, shifting
  // the rest of the line. Unicode 11 widths match real terminals.
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
  term.open(host);
  // A view scrolled up stays on what you were reading when the agent reprints its transcript (repaint-scroll.ts).
  const repaint = new RepaintScroll(term);
  // GPU renderer: the DOM renderer is what makes a busy Claude feel sluggish (every spinner frame re-lays out spans).
  // Loaded after open(), unless this is a software rasterizer (webgl-gate.ts). A lost context is tried again after a
  // pause; hidden in the deck the terminal lets its context go and gets a new one when shown (webgl-renderer.ts).
  const webgl = new WebglRenderer<WebglAddon>(
    {
      create: () => new WebglAddon(),
      load: (addon) => term.loadAddon(addon),
      canvases: () => term.element?.querySelectorAll('canvas') ?? [],
      label,
      // The two renderers measure a cell differently: refit after a swap, or the grid is a column off until the next resize.
      refit,
    },
    active,
    pageWebglRefusal(),
  );
  // A web font of the stack that arrives after open(): the cell measured again (xterm does only when the option
  // changes, so through a generic family and back), the atlas redrawn, the grid fitted — shown only (font-settle.ts).
  const stopFonts = onFontsSettled(
    document.fonts,
    () => term.options.fontFamily ?? '',
    () => {
      const family = term.options.fontFamily;
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = family;
      term.clearTextureAtlas();
      refit();
    },
  );

  // What a key sends that xterm itself doesn't (Shift+Enter): to the same listeners as its onData.
  const listeners = new Set<(data: string) => void>();
  const send = (data: string) => {
    for (const l of listeners) l(data);
  };

  // Keys a real terminal handles that xterm-in-a-browser doesn't:
  //  - Shift+Enter → newline in Claude's prompt (ESC CR, what Claude
  //    Code's /terminal-setup binds) instead of submitting.
  //  - Ctrl+C with a selection → copy, like Windows Terminal; without a
  //    selection it stays an interrupt.
  // Every copy is put back together first (terminal-copy.ts): Claude Code's
  // wrapping, indent and padding taken out.
  // A table, bold or italic in it goes as HTML too, so Teams or Outlook paste it formatted (rich-copy.ts).
  const selected = () => terminalCopy(selectionText(term), term.cols, term.getSelectionPosition()?.start.x ?? 0);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      send('\x1b\r');
      return false;
    }
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey && term.hasSelection()) {
      void writeRich(selected()).catch(() => {});
      term.clearSelection();
      return false;
    }
    // Paste: xterm turns Ctrl+V into ^V and swallows the key, so the browser
    // never pasted. Leave these to the browser; its paste event reaches
    // xterm, which sends the text (bracketed when Claude asked for it).
    if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) return false;
    return true;
  });
  // The browser's own copy (Ctrl+Shift+C, the menu's Copy, the desktop app's): the same text.
  const onCopy = (ev: ClipboardEvent) => {
    if (!term.hasSelection() || !ev.clipboardData) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const { text, html } = selected();
    ev.clipboardData.setData('text/plain', text);
    if (html) ev.clipboardData.setData('text/html', html);
  };
  const element = term.element;
  element?.addEventListener('copy', onCopy, true);

  return {
    kind: 'xterm',
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get textarea() {
      return term.textarea;
    },
    write: (data, done) => term.write(data, done),
    writeOutput: (data, done) =>
      term.write(data, () => {
        done();
        repaint.written();
      }),
    resize: (cols, rows) => term.resize(cols, rows),
    // The line at the top of the view stays there when you had scrolled up (a marker follows it through the reflow),
    // and the view stays at the bottom when it was there.
    resizeKeepingView(cols, rows) {
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      const marker = atBottom ? undefined : term.registerMarker(buf.viewportY - (buf.baseY + buf.cursorY));
      term.resize(cols, rows);
      if (atBottom) term.scrollToBottom();
      else if (marker && !marker.isDisposed && marker.line >= 0) term.scrollToLine(marker.line);
      marker?.dispose();
    },
    proposeDimensions: () => fit.proposeDimensions(),
    focus: () => term.focus(),
    scrollToBottom: () => term.scrollToBottom(),
    // ConPTY reflows lines itself on a resize: xterm.js must not reflow them again (VS Code sets the same; terminal-size.ts).
    setWindowsPty(info: WindowsPty) {
      term.options.windowsPty = info;
    },
    onData(listener): Disposable {
      const sub = term.onData(listener);
      listeners.add(listener);
      return {
        dispose() {
          sub.dispose();
          listeners.delete(listener);
        },
      };
    },
    onRender: (listener) => term.onRender(() => listener()),
    // WebGL back before the fit, so the grid is measured with the renderer that draws it.
    shown: () => webgl.shown(),
    hidden: () => webgl.hidden(),
    dispose() {
      element?.removeEventListener('copy', onCopy, true);
      stopFonts();
      repaint.dispose();
      // Before the terminal goes: its context lost, not left to the garbage collector (webgl-renderer.ts).
      webgl.dispose();
      term.dispose();
    },
  };
}
