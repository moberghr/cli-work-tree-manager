/**
 * Env var marker set on work's OWN internal `claude -p` invocations
 * (checkpoint naming, Jira branch slug, CLAUDE.md generation). The `work hook`
 * handler bails the moment it sees this, so those headless Claude runs don't
 * recursively trip work's own UserPromptSubmit/Stop checkpoint hooks.
 *
 * Without it, naming a checkpoint spawns `claude -p`, whose UserPromptSubmit
 * seals the live step and whose Stop appends a new checkpoint — which triggers
 * another naming run, and so on. That feedback loop fragments a single Claude
 * round into many spurious steps. Tagging the subprocess (env is inherited by
 * the hook commands Claude spawns) breaks the loop at the source.
 */
export const INTERNAL_CLAUDE_ENV = 'WORK_INTERNAL_CLAUDE';

/** Env overlay to spawn an internal `claude` with: `{ ...process.env, ...internalClaudeEnv() }`. */
export function internalClaudeEnv(): Record<string, string> {
  return { [INTERNAL_CLAUDE_ENV]: '1' };
}

/** True when the current process was spawned by one of work's internal
 *  `claude` invocations — used by `work hook` to no-op. */
export function isInternalClaude(): boolean {
  return process.env[INTERNAL_CLAUDE_ENV] === '1';
}
