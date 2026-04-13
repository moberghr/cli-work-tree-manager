import type { WorkConfig } from './config.js';

/** Resolved AI tool spec ready for spawning. */
export interface AiToolSpec {
  /** Executable name. */
  cmd: string;
  /** Arguments always prepended (from any extra tokens in `aiCommand`). */
  baseArgs: string[];
  /** Flag injected when `--unsafe` is used. Empty string disables. */
  unsafeFlag: string;
  /** Flag injected when resuming a prior session. Empty string disables. */
  resumeFlag: string;
  /**
   * Flag used to pass an initial prompt as a file (followed by the file path).
   * Empty string disables.
   */
  promptFileFlag: string;
}

export interface AiLaunchOpts {
  unsafe?: boolean;
  resume?: boolean;
  promptFile?: string;
  /** Inline prompt appended as a positional argument (used by CLI `--prompt`). */
  initialPrompt?: string;
}

const DEFAULT_FLAGS = {
  unsafe: '--dangerously-skip-permissions',
  resume: '--continue',
  promptFile: '--prompt-file',
} as const;

/**
 * Resolve the configured AI tool. Falls back to `claude` with its standard flags
 * so default behavior is preserved when no `aiCommand` is set.
 */
export function getAiTool(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'>): AiToolSpec {
  const command = (config.aiCommand ?? 'claude').trim();
  const parts = command.split(/\s+/).filter(Boolean);
  const cmd = parts[0] || 'claude';
  const baseArgs = parts.slice(1);
  const flags = config.aiCommandFlags ?? {};
  return {
    cmd,
    baseArgs,
    unsafeFlag: flags.unsafe ?? DEFAULT_FLAGS.unsafe,
    resumeFlag: flags.resume ?? DEFAULT_FLAGS.resume,
    promptFileFlag: flags.promptFile ?? DEFAULT_FLAGS.promptFile,
  };
}

/** Build the final `{ cmd, args }` to spawn for the given launch options. */
export function buildAiLaunchArgs(tool: AiToolSpec, opts: AiLaunchOpts = {}): { cmd: string; args: string[] } {
  const args = [...tool.baseArgs];
  if (opts.unsafe && tool.unsafeFlag) args.push(tool.unsafeFlag);
  if (opts.resume && tool.resumeFlag) args.push(tool.resumeFlag);
  if (opts.promptFile && tool.promptFileFlag) {
    args.push(tool.promptFileFlag, opts.promptFile);
  }
  if (opts.initialPrompt) args.push(opts.initialPrompt);
  return { cmd: tool.cmd, args };
}
