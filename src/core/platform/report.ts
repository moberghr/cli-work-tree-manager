import { AsyncLocalStorage } from 'node:async_hooks';
import { debugLog } from './logger.js';

/**
 * How core tells whoever called it what is happening — without printing.
 * Core never writes to the console (architecture test): the CLI renders
 * reports with colors, the server records them in the debug log (or hands
 * errors back in its response), and a future app can show them in a panel.
 *
 * The reporter is scoped, not threaded through every signature:
 * `withReporter(r, fn)` makes `r` the target of every `report()` made while
 * `fn` runs, across awaits (AsyncLocalStorage), so concurrent server
 * requests each get their own. Outside any scope, reports go to the debug log.
 */

/** step — an action starting · info — plain · detail — secondary ·
 *  success · warn — did it anyway / skipped something · error — failed. */
export type ReportLevel = 'step' | 'info' | 'detail' | 'success' | 'warn' | 'error';

export type Reporter = (level: ReportLevel, text: string) => void;

const DEBUG_LEVEL: Record<ReportLevel, 'INFO' | 'WARN' | 'ERROR'> = {
  step: 'INFO',
  info: 'INFO',
  detail: 'INFO',
  success: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/** Where reports go with no reporter in scope (servers, background jobs). */
export const debugReporter: Reporter = (level, text) => debugLog(DEBUG_LEVEL[level], text);

const scope = new AsyncLocalStorage<Reporter>();

/** Run `fn` with `reporter` receiving every report made inside it. */
export function withReporter<T>(reporter: Reporter, fn: () => T): T {
  return scope.run(reporter, fn);
}

export function report(level: ReportLevel, text: string): void {
  (scope.getStore() ?? debugReporter)(level, text);
}

/** A reporter that keeps what it gets — for handing errors back in an API
 *  response, and for tests. */
export function collectingReporter(): Reporter & { entries: Array<{ level: ReportLevel; text: string }>; errors(): string[] } {
  const entries: Array<{ level: ReportLevel; text: string }> = [];
  const r = ((level: ReportLevel, text: string) => {
    entries.push({ level, text });
    debugReporter(level, text); // still in the log
  }) as Reporter & { entries: typeof entries; errors(): string[] };
  r.entries = entries;
  r.errors = () => entries.filter((e) => e.level === 'error').map((e) => e.text);
  return r;
}
