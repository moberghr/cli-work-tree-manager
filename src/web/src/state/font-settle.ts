/**
 * When the Terminal tab measures its cell again because a font arrived (terminal-rendering.md, "Fonts and the
 * renderer").
 *
 * xterm.js measures its cell when it opens, and again only when `fontFamily` or `fontSize` change or the grid is
 * resized. A web font that arrives after the open leaves the grid measured for the fallback font, and the WebGL glyph
 * atlas holding the fallback's glyphs, until something resizes the pane. So once the document's fonts are ready, and
 * whenever a load of faces finishes (`loadingdone`), the tab measures again — when one of the faces is in its own font
 * stack: a face of another family changes nothing in the terminal, and measuring costs a new atlas.
 *
 * The stack today is local fonts only (no `@font-face` in the SPA), so neither happens; this is for the day the stack
 * names a web font. coder clears its atlas on every `loadingdone` (site/src/modules/terminal/WorkspaceTerminal.tsx),
 * Hermes waits for its bundled faces (web/src/lib/terminal-font-refit.ts), Paradev for `document.fonts.load` of its
 * stack (apps/desktop/src/renderer/lib/terminal/font-settle.ts).
 *
 * Import-free: the font set and the timers are passed in.
 */

/** Faces arrive in bursts (a family's weights and styles, one `loadingdone` each): one measure for the burst. */
export const FONT_SETTLE_MS = 100;

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');

/** The families of a CSS `font-family` list, unquoted and lower-cased: `"Cascadia Code", monospace` → both names. */
export function fontFamilies(stack: string): string[] {
  return stack
    .split(',')
    .map((f) => unquote(f.trim()).trim().toLowerCase())
    .filter((f) => f.length > 0);
}

/** One of `faces` is a family of `stack` (a face's family may come quoted, as FontFace reports it in some engines). */
export function touchesStack(faces: Iterable<{ family: string }>, stack: string): boolean {
  const ours = new Set(fontFamilies(stack));
  for (const face of faces) if (fontFamilies(face.family).some((f) => ours.has(f))) return true;
  return false;
}

/** A face as the font set lists it: its family and FontFace's `status` ('unloaded', 'loading', 'loaded', 'error'). */
export interface FaceLike {
  family: string;
  status: string;
}

export interface FontSetLike extends Iterable<FaceLike> {
  readonly ready: Promise<unknown>;
  addEventListener(type: 'loadingdone', fn: (e: Event) => void): void;
  removeEventListener(type: 'loadingdone', fn: (e: Event) => void): void;
}

export interface SettleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: SettleTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `remeasure` once the fonts are ready, if a face of `stack()` that was not loaded yet when this was called has
 * loaded by then, and after each burst of loads that includes a face of `stack()`. Call it right after the terminal
 * opens: what loaded before was measured. Returns what stops it. With no font set (an old engine, a test's DOM), it
 * does nothing.
 */
export function onFontsSettled(
  fonts: FontSetLike | undefined,
  stack: () => string,
  remeasure: () => void,
  timers: SettleTimers = browserTimers,
  ms = FONT_SETTLE_MS,
): () => void {
  if (!fonts) return () => {};
  let stopped = false;
  let pending: unknown = null;
  const soon = () => {
    if (stopped || pending !== null) return;
    pending = timers.set(() => {
      pending = null;
      if (!stopped) remeasure();
    }, ms);
  };
  const waiting = [...fonts].filter((f) => f.status === 'unloaded' || f.status === 'loading');
  const arrived = () => waiting.filter((f) => f.status === 'loaded');
  void fonts.ready.then(
    () => {
      if (touchesStack(arrived(), stack())) soon();
    },
    () => {},
  );
  const onDone = (e: Event) => {
    const faces = (e as Event & { fontfaces?: ReadonlyArray<{ family: string }> }).fontfaces;
    if (touchesStack(faces ?? [], stack())) soon();
  };
  fonts.addEventListener('loadingdone', onDone);
  return () => {
    stopped = true;
    if (pending !== null) timers.clear(pending);
    pending = null;
    fonts.removeEventListener('loadingdone', onDone);
  };
}
