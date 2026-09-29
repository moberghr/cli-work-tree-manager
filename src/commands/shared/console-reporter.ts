import chalk from 'chalk';
import type { ReportLevel, Reporter } from '../../core/report.js';

/**
 * How the CLI shows core's reports. Colors live here, not in core.
 *
 * `stream`: `work` writes to stdout (as it always has); `wd` writes status
 * to stderr, since its stdout carries data only (the review markdown). Errors
 * always go to stderr.
 */
const COLOR: Record<ReportLevel, (s: string) => string> = {
  step: chalk.cyan,
  info: (s) => s,
  detail: chalk.gray,
  success: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
};

export function consoleReporter(stream: 'stdout' | 'stderr' = 'stdout'): Reporter {
  return (level, text) => {
    const line = COLOR[level](text);
    if (level === 'error' || stream === 'stderr') console.error(line);
    else console.log(line);
  };
}
