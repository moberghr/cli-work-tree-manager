import { instantiate } from './wasm.js';
import { VtTerminal, type GhosttyEvents, type GhosttyOptions } from './vt-terminal.js';

/**
 * The PTY host's libghostty-vt terminal (Node): a VtTerminal (vt-terminal.ts, the binding the browser shares) in an
 * instance of the module read from its file (wasm.ts). Only what the screen copy needs.
 */

export {
  EXTRA,
  type FormatOptions,
  type GhosttyEvents,
  type GhosttyOptions,
  type GridPoint,
  type NativeProgram,
  type NativeProgress,
} from './vt-terminal.js';

export type GhosttyTerminal = VtTerminal;

export const GhosttyTerminal = {
  /** Throws if libghostty-vt can't be loaded or the terminal made. */
  create(cols: number, rows: number, opts: GhosttyOptions, events: GhosttyEvents = {}): GhosttyTerminal {
    return VtTerminal.create(instantiate(), cols, rows, opts, events);
  },
};
