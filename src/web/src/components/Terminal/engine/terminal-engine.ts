import { fetchSettings } from '../../../api/panes.js';
import type { WindowsPty } from '../../../../../core/pty/terminal-size.js';

/**
 * What PtyView needs from the terminal that draws a session (terminal-rendering.md, "The Terminal tab's engines"):
 * xterm.js (xterm-engine.ts, the default) or libghostty-vt drawn on a canvas (ghostty-engine.ts, loaded only when
 * picked). PtyView keeps the socket, the frames and their acks, the replay gate, reconnects, latency, the perf log and
 * when to fit; an engine parses, draws, measures, and turns the keyboard into what the PTY is sent.
 */

/** The Terminal tab's font: Cascadia is Windows Terminal's default — same glyphs, same widths. Both engines draw with it. */
export const TERMINAL_FONT = '"Cascadia Code", "Cascadia Mono", SFMono-Regular, Consolas, "Liberation Mono", monospace';
export const TERMINAL_FONT_SIZE = 13;

export interface Disposable {
  dispose(): void;
}

/** Which renderer draws (the corner badge): xterm.js's WebGL or DOM one, or libghostty-vt's canvas. */
export type RendererLabel = 'webgl' | 'retrying' | 'dom' | 'ghostty';

export interface EngineOptions {
  /** The element it draws in. */
  host: HTMLElement;
  /** Shown when made (kept in the deck hidden, it holds back what it can). */
  active: boolean;
  /** Which renderer draws, now and whenever it changes. */
  label(renderer: RendererLabel): void;
  /** What a cell measures changed (a font arrived, the renderer changed): fit again. */
  refit(): void;
}

export interface TerminalEngine {
  readonly kind: EngineKind;
  readonly cols: number;
  readonly rows: number;
  /** Where the keyboard goes: PtyView listens to it for focus and pastes. */
  readonly textarea: HTMLTextAreaElement | undefined;
  /** `data` parsed and drawn, in order with every other write; `done` once it has been parsed. */
  write(data: string | Uint8Array, done?: () => void): void;
  /** The PTY's output (not a screen): the same, and a view scrolled up stays on what you were reading. */
  writeOutput(data: Uint8Array, done: () => void): void;
  resize(cols: number, rows: number): void;
  /** Resized with the view kept: scrolled up, on the line it showed; at the bottom, at the bottom. */
  resizeKeepingView(cols: number, rows: number): void;
  /** The grid its element holds at its font (FitAddon's measure), or undefined when it can't be told. */
  proposeDimensions(): { cols: number; rows: number } | undefined;
  focus(): void;
  scrollToBottom(): void;
  /** The PTY host's terminals are ConPTY's (a host on Windows says so). */
  setWindowsPty(info: WindowsPty): void;
  /** What the keyboard (or a paste) sends the PTY. */
  onData(listener: (data: string) => void): Disposable;
  /** A frame was drawn. */
  onRender(listener: () => void): Disposable;
  /** Shown again in the deck / hidden in it. */
  shown(): void;
  hidden(): void;
  dispose(): void;
}

export type EngineKind = 'xterm' | 'ghostty';

const isKind = (v: unknown): v is EngineKind => v === 'xterm' || v === 'ghostty';
/** `?terminalEngine=` kept for this browser: a try of the other engine outlives a reload. */
const OVERRIDE_KEY = 'work.terminalEngine';
/** The setting (config `terminalEngine`) as last read: the first terminal of the next page load knows it at once. */
const SETTING_KEY = 'work.terminalEngine.setting';

function stored(key: string): EngineKind | null {
  try {
    const v = localStorage.getItem(key);
    return isKind(v) ? v : null;
  } catch {
    return null;
  }
}

function store(key: string, v: EngineKind | null): void {
  try {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked: the choice lasts this page only */
  }
}

let setting: EngineKind | null = null;
let settingRead: Promise<void> | null = null;

/**
 * Reads the `terminalEngine` setting (the one the PTY host uses) once per page, in the background: the terminals made
 * after it arrives use it, and it is remembered for the next page load.
 */
export function readEngineSetting(load: () => Promise<{ values: Record<string, unknown> }> = fetchSettings): Promise<void> {
  settingRead ??= load().then(
    (s) => {
      const v = s.values.terminalEngine;
      setting = isKind(v) ? v : 'xterm';
      store(SETTING_KEY, setting);
    },
    () => {
      /* no setting to be had (an older server, offline): the last known one, else xterm */
    },
  );
  return settingRead;
}

/**
 * The engine a terminal made now uses: `?terminalEngine=ghostty|xterm` on the page's address (remembered in this
 * browser; `?terminalEngine=` alone forgets it), else the one remembered, else the setting, else xterm.js.
 */
export function engineChoice(search = typeof location === 'undefined' ? '' : location.search): EngineKind {
  const params = new URLSearchParams(search);
  if (params.has('terminalEngine')) {
    const asked = params.get('terminalEngine');
    store(OVERRIDE_KEY, isKind(asked) ? asked : null);
  }
  return stored(OVERRIDE_KEY) ?? setting ?? stored(SETTING_KEY) ?? 'xterm';
}

/** For tests: forget the setting read. */
export function resetEngineSetting(): void {
  setting = null;
  settingRead = null;
}

/** The libghostty-vt engine, its code and the module loaded on first use (a chunk of their own: nobody on xterm.js pays for them). */
export async function loadGhosttyEngine(options: EngineOptions): Promise<TerminalEngine> {
  const { createGhosttyEngine } = await import('./ghostty-engine.js');
  return createGhosttyEngine(options);
}
