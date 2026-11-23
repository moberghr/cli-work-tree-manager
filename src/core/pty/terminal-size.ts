/**
 * A terminal's size, as clients state it and the PTY host takes it (terminal-rendering.md, "Resizing and attaching at
 * a size"). Pure and import-free: the browser's Terminal tab, `work attach`, work web's relay and the host share it.
 *
 * - **Attaching at a size.** A client that takes the PTY's size anyway (the terminal shown, `work attach`; never a
 *   hidden one) states its grid on its attach address (`?cols=…&rows=…`, `withGrid`). The host resizes the PTY and its
 *   screen copy to it before it takes the snapshot, so the client draws the snapshot at its own grid: no second reflow,
 *   no repaint after the fact. An older host ignores the parameters, and the client's resize after the replay (sent as
 *   before) does it the old way.
 * - **Starting at a size.** A tab asking for its terminal states the same grid, so an agent it starts is started at it.
 * - **ConPTY.** On Windows the pseudo-console reflows lines itself; a terminal that reflows them again on a resize draws
 *   them twice (`windowsPty`, which xterm.js reads to leave that to ConPTY).
 */

/** Columns and rows. */
export interface Grid {
  cols: number;
  rows: number;
}

/** The smallest grid the host takes (one row is no screen for a TUI; the registry refused under 2 before this). */
export const MIN_COLS = 2;
export const MIN_ROWS = 2;
/** The largest: a grid is a buffer of cols × (rows + scrollback) cells in the host's screen copy, so a client can't ask for an absurd one. */
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;

/** The attach address's parameters for a stated grid. An older host ignores them. */
export const COLS_PARAM = 'cols';
export const ROWS_PARAM = 'rows';

/** `cols` × `rows` when both are whole numbers within MIN..MAX, else null. */
export function validGrid(cols: unknown, rows: unknown): Grid | null {
  const ok = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  return ok(cols, MIN_COLS, MAX_COLS) && ok(rows, MIN_ROWS, MAX_ROWS) ? { cols, rows } : null;
}

/** `url` with the grid stated (`?cols=…&rows=…`); `url` as it is when there is none. */
export function withGrid(url: string, grid: Grid | null | undefined): string {
  if (!grid) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${COLS_PARAM}=${grid.cols}&${ROWS_PARAM}=${grid.rows}`;
}

/** The grid stated on an attach address (URLSearchParams), or null: none, or not a valid one. */
export function gridFromParams(params: { get(name: string): string | null }): Grid | null {
  const num = (s: string | null) => (s !== null && /^\d{1,4}$/.test(s) ? Number(s) : NaN);
  return validGrid(num(params.get(COLS_PARAM)), num(params.get(ROWS_PARAM)));
}

/** Two grids the same (null for none equals nothing). */
export function sameGrid(a: Grid | null | undefined, b: Grid | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

/** xterm.js's `windowsPty` option, as the host tells a client and sets on its screen copy. */
export interface WindowsPty {
  backend: 'conpty';
  buildNumber: number;
}

/**
 * The `windowsPty` option for a PTY host on `platform` with `os.release()` = `release` ("10.0.22631"): ConPTY and the
 * Windows build, as VS Code sets it (terminalProcess.ts `getWindowsPty`). xterm.js 6 then reflows lines on a resize
 * only from build 21376 (where ConPTY reflows them too), turns on its wrapping heuristics below it, and adds rows at the
 * bottom on a grow instead of pulling lines back from the scrollback (ConPTY reprints its view). Undefined off Windows,
 * or when the build can't be read.
 */
export function windowsPtyFor(platform: string, release: string): WindowsPty | undefined {
  if (platform !== 'win32') return undefined;
  const build = Number(/^\d+\.\d+\.(\d+)/.exec(release)?.[1]);
  return Number.isInteger(build) && build > 0 ? { backend: 'conpty', buildNumber: build } : undefined;
}

/** A `windowsPty` as read off the wire (the replay frame): shape-checked, never cast. */
export function isWindowsPty(x: unknown): x is WindowsPty {
  const w = x as WindowsPty | null;
  return !!w && typeof w === 'object' && w.backend === 'conpty' && Number.isInteger(w.buildNumber) && w.buildNumber > 0;
}
