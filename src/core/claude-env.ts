/**
 * Claude Code marks the processes it runs with its own session: whether
 * it's a child session, its session id, pid, messaging socket and token.
 * A Claude that `work` starts is a session of its own, but it inherits
 * these whenever `work` itself was started from inside a Claude — `work
 * tree` typed in Claude's shell, or the PTY host restarted by one. Then it
 * believes it's a child session and doesn't save its transcript ("Transcript
 * saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"), and carries
 * another session's messaging token.
 *
 * Only the session's identity goes; user settings (CLAUDE_CONFIG_DIR,
 * CLAUDE_CODE_USE_BEDROCK, API keys, …) are kept.
 */
export const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
] as const;

/** `env` without the parent Claude session's markers (case-insensitive, for Windows). */
export function withoutParentSession<T extends Record<string, string | undefined>>(env: T): T {
  const drop = new Set<string>(PARENT_SESSION_VARS);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toUpperCase()))) as T;
}
