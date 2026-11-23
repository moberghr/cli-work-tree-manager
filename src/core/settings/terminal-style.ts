/**
 * How every terminal in work looks: the colour themes, the font and the line height, and how the Settings page's
 * values (and the few colours written by hand in config.json) become one style. Pure and import-free, because the
 * SPA bundles it (the terminal draws itself with it) and the server's settings reader checks the hand-written colours
 * with it, so both agree on what fits.
 *
 * A bad value never breaks a terminal: each field falls back to its own default and keeps the others.
 */

export type TerminalThemeId = 'default' | 'midnight' | 'dracula' | 'tokyo-night' | 'github-light';

/** The colours of a terminal, named as xterm's own theme names them (so a palette is its `theme` as it is). */
export const TERMINAL_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number];

export type TerminalPalette = Record<TerminalColorKey, string>;

export const TERMINAL_THEMES: readonly { id: TerminalThemeId; label: string; palette: TerminalPalette }[] = [
  {
    // Today's look: xterm's own defaults, spelled out.
    id: 'default',
    label: 'Default dark',
    palette: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: '#ffffff4d',
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    },
  },
  {
    // Near-black and crisp: work's own.
    id: 'midnight',
    label: 'Midnight',
    palette: {
      background: '#0d0d10',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      cursorAccent: '#0d0d10',
      selectionBackground: '#52525b80',
      black: '#27272a',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#d4d4d8',
      brightBlack: '#52525b',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#fafafa',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    palette: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    palette: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#283457',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    palette: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      selectionBackground: '#0969da33',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f',
    },
  },
];

export const DEFAULT_TERMINAL_THEME: TerminalThemeId = 'default';

/** Cascadia is Windows Terminal's default — same glyphs, same widths. */
export const DEFAULT_TERMINAL_FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", SFMono-Regular, Consolas, "Liberation Mono", monospace';

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_SIZE_RANGE = { min: 8, max: 32 };

export const DEFAULT_TERMINAL_LINE_HEIGHT = 1;
export const TERMINAL_LINE_HEIGHT_RANGE = { min: 1, max: 2 };

/** A font name, or several separated by commas. It refuses ; { } < > \ — what would end a CSS value or open a rule. */
export const TERMINAL_FONT_PATTERN = '^[^;{}<>\\\\]+$';
const FONT = new RegExp(TERMINAL_FONT_PATTERN);

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HEX_COLOUR_ALPHA = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const KNOWN_KEYS: ReadonlySet<string> = new Set(TERMINAL_COLOR_KEYS);

/**
 * The colours of config.json's `terminal.colors` that fit: a known key with a hex colour (3 or 6 digits; 8, with
 * alpha, for the selection only — xterm draws the others opaque, and a see-through background would leave the
 * terminal's frame see-through over the page). The rest is dropped silently: it is written by hand, and loadConfig
 * drops what doesn't fit too.
 */
export function checkTerminalColors(raw: unknown): Partial<Record<TerminalColorKey, string>> {
  const out: Partial<Record<TerminalColorKey, string>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const colour = key === 'selectionBackground' ? HEX_COLOUR_ALPHA : HEX_COLOUR;
    if (KNOWN_KEYS.has(key) && typeof value === 'string' && colour.test(value)) out[key as TerminalColorKey] = value;
  }
  return out;
}

// The generic families, written bare: quoted, "monospace" is a font called monospace.
const GENERIC_FONTS: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/**
 * The user's fonts as a list CSS takes: each name trimmed, its quotes taken out and put back around it (a stray quote,
 * `"Hack`, would void the whole list, today's stack with it), the empty ones dropped, a generic family bare.
 */
function fontList(text: string): string {
  return text
    .split(',')
    .map((name) => name.replace(/["']/g, '').trim())
    .filter(Boolean)
    .map((name) => (GENERIC_FONTS.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`))
    .join(', ');
}

export interface TerminalStyle {
  themeId: TerminalThemeId;
  theme: TerminalPalette;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

const inRange = (v: unknown, range: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= range.min && v <= range.max;

/**
 * The style a terminal draws with, from the Settings page's values (by path, as `SettingsWire.values` has them) and
 * the hand-written colours over the theme. Field by field: one that doesn't fit is its default, the others stand.
 */
export function resolveTerminalStyle(values: Record<string, unknown>, colors?: Partial<Record<TerminalColorKey, string>>): TerminalStyle {
  const base = TERMINAL_THEMES.find((t) => t.id === values['terminal.theme']) ?? TERMINAL_THEMES[0]!;

  const font = values['terminal.fontFamily'];
  // The user's font first, today's stack after it: a name that isn't installed falls back to it.
  const fonts = typeof font === 'string' && FONT.test(font) ? fontList(font) : '';
  const fontFamily = fonts ? `${fonts}, ${DEFAULT_TERMINAL_FONT_FAMILY}` : DEFAULT_TERMINAL_FONT_FAMILY;

  const size = values['terminal.fontSize'];
  const line = values['terminal.lineHeight'];
  return {
    themeId: base.id,
    theme: { ...base.palette, ...checkTerminalColors(colors) },
    fontFamily,
    fontSize: inRange(size, TERMINAL_FONT_SIZE_RANGE) ? size : DEFAULT_TERMINAL_FONT_SIZE,
    lineHeight: inRange(line, TERMINAL_LINE_HEIGHT_RANGE) ? line : DEFAULT_TERMINAL_LINE_HEIGHT,
  };
}

export const DEFAULT_TERMINAL_STYLE: TerminalStyle = resolveTerminalStyle({});
