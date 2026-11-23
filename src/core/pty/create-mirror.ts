import { loadConfig } from '../platform/config.js';
import { report } from '../platform/report.js';
import { GhosttyMirror } from './ghostty-mirror.js';
import type { TerminalMirror } from './mirror.js';
import { ScreenMirror } from './screen-mirror.js';
import type { WindowsPty } from './terminal-size.js';

export type TerminalEngine = 'xterm' | 'ghostty';

const isEngine = (v: unknown): v is TerminalEngine => v === 'xterm' || v === 'ghostty';

/** Config `terminalEngine` (undefined when config can't be read). */
function configuredEngine(): unknown {
  try {
    return loadConfig()?.terminalEngine;
  } catch {
    return undefined;
  }
}

/** `WORK_TERMINAL_ENGINE` (xterm | ghostty) wins, else config `terminalEngine`, else xterm. */
export function terminalEngine(env: NodeJS.ProcessEnv = process.env, configured: () => unknown = configuredEngine): TerminalEngine {
  const fromEnv = env.WORK_TERMINAL_ENGINE;
  if (isEngine(fromEnv)) return fromEnv;
  const fromConfig = configured();
  return isEngine(fromConfig) ? fromConfig : 'xterm';
}

let warned = false;

/**
 * A screen copy on the engine asked for (read now: once per terminal). If libghostty-vt can't be loaded, the copy is
 * xterm's and that is reported once per process; the PTY host never fails over it.
 */
export function createMirror(cols: number, rows: number, opts: { windowsPty?: WindowsPty; engine?: TerminalEngine } = {}): TerminalMirror {
  const engine = opts.engine ?? terminalEngine();
  if (engine === 'ghostty') {
    try {
      return new GhosttyMirror(cols, rows, undefined, { windowsPty: opts.windowsPty });
    } catch (err) {
      if (!warned) {
        warned = true;
        report(
          'warn',
          `libghostty-vt could not be loaded (${err instanceof Error ? err.message : String(err)}); terminals use xterm's screen copy`,
        );
      }
    }
  }
  return new ScreenMirror(cols, rows, undefined, { windowsPty: opts.windowsPty });
}
