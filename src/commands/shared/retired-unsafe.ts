import chalk from 'chalk';

// `--unsafe` started the agent with its skip-permissions flag. work no longer
// does that: every agent starts in its own permission mode, and Claude Code's
// own modes (auto mode, its allow rules) are where that choice lives. The flag
// is still accepted for one release so scripts and aliases don't break.

/** What `work tree / resume / recent --unsafe` says now. */
export const UNSAFE_GONE = "--unsafe is gone: work starts the agent in its normal permission mode — use Claude Code's own (e.g. auto mode)";

/** The hidden option those commands keep for one release. Accepted, does nothing. */
export const retiredUnsafeOption = { type: 'boolean', hidden: true } as const;

/** Warn when it was given. Returns whether it was. */
export function warnRetiredUnsafe(argv: Record<string, unknown>): boolean {
  if (argv.unsafe !== true) return false;
  console.error(chalk.yellow(UNSAFE_GONE));
  return true;
}
