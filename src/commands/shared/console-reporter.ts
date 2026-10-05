import chalk from 'chalk';
import type { ReportLevel, Reporter } from '../../core/platform/report.js';

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

/**
 * Where a `work` invocation shows its reports: stderr when it was asked for
 * `--json`, whose stdout must be the JSON and nothing else (a script parses
 * it — `work cleanup --apply --json` once mixed "Removed worktree" lines into
 * it); stdout otherwise. Arguments after a bare `--` belong to something else.
 */
export function reportStreamFor(args: readonly string[]): 'stdout' | 'stderr' {
  const end = args.indexOf('--');
  const own = end === -1 ? args : args.slice(0, end);
  return own.some((a) => a === '--json' || a === '--json=true') ? 'stderr' : 'stdout';
}

export function consoleReporter(stream: 'stdout' | 'stderr' = 'stdout'): Reporter {
  return (level, text) => {
    const line = COLOR[level](text);
    if (level === 'error' || stream === 'stderr') console.error(line);
    else console.log(line);
  };
}
