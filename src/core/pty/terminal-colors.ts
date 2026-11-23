/**
 * The Terminal tab's colours, and what the PTY host answers an agent's colour query with when no terminal is attached
 * to answer it (terminal-rendering.md, "Who answers a query"). Pure and import-free: the SPA imports it (PtyView's theme).
 */

/** The Terminal tab's theme (PtyView). The cursor is xterm.js's default, stated so the host answers OSC 12 as the tab does. */
export const TERMINAL_THEME = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' } as const;

/** xterm.js's default 16 colours (`DEFAULT_ANSI_COLORS`): what the tab answers OSC 4 with, the theme setting none. */
const ANSI_16 = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec',
];
const CUBE = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

/** Colour `index` (0–255) of xterm.js's default palette as `[r, g, b]`: the 16 above, the 6×6×6 cube, 24 greys. */
function paletteRgb(index: number): [number, number, number] {
  if (index < 16) return hexRgb(ANSI_16[index]);
  if (index < 232) {
    const i = index - 16;
    return [CUBE[Math.floor(i / 36) % 6], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]];
  }
  const c = 8 + (index - 232) * 10;
  return [c, c, c];
}

function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** As xterm.js says a colour in a reply (`toRgbString`): 16 bits a channel, `rgb:1e1e/1e1e/1e1e`. */
function rgbSpec([r, g, b]: [number, number, number]): string {
  const two = (n: number) => n.toString(16).padStart(2, '0').repeat(2);
  return `rgb:${two(r)}/${two(g)}/${two(b)}`;
}

/** A colour reply's value we repeat: `rgb:` with 1–4 hex digits a channel, or `#` and hex. Nothing else is said back. */
const SPEC = /^(?:rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}|#(?:[\da-f]{3}){1,4})$/i;
/** A colour reply: OSC 10, 11 or 12, or OSC 4 with its index; then the value, then BEL or ST. */
const COLOR_REPLY = /^\x1b\]((?:1[0-2])|4;\d{1,3});([^\x07\x1b]*)(?:\x07|\x1b\\)$/;

/**
 * The colours an agent's colour queries are answered with when the PTY host answers them itself: the last a terminal
 * attached to any of its PTYs answered with (`remember`, given each answer the host lets through), else the Terminal
 * tab's. One per host process: a terminal's colours don't depend on the session it shows.
 */
export class TerminalColors {
  private readonly seen = new Map<string, string>();

  /** A colour reply a terminal sent (`ESC ] 11 ; rgb:… ST`): remembered for its slot. Anything else is ignored. */
  remember(reply: string): void {
    const m = COLOR_REPLY.exec(reply);
    if (!m || !SPEC.test(m[2])) return;
    const slot = m[1].startsWith('4;') ? `4;${Number(m[1].slice(2))}` : m[1];
    if (slot.startsWith('4;') && Number(slot.slice(2)) > 255) return;
    this.seen.set(slot, m[2]);
  }

  /** The value to answer a query for `slot` with: `10`, `11`, `12`, or `4;<index>` (0–255). */
  value(slot: string): string {
    const seen = this.seen.get(slot);
    if (seen) return seen;
    if (slot === '10') return rgbSpec(hexRgb(TERMINAL_THEME.foreground));
    if (slot === '11') return rgbSpec(hexRgb(TERMINAL_THEME.background));
    if (slot === '12') return rgbSpec(hexRgb(TERMINAL_THEME.cursor));
    return rgbSpec(paletteRgb(Number(slot.slice(2))));
  }

  /** The whole reply for `slot`, as xterm.js says it (ST-terminated). */
  reply(slot: string): string {
    return `\x1b]${slot};${this.value(slot)}\x1b\\`;
  }
}
