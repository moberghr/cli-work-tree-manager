import fs from 'node:fs';
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
   * Empty string disables — prompt-file content will be inlined via `promptFlag`
   * instead, if available.
   */
  promptFileFlag: string;
  /**
   * Flag used to pass an inline prompt (followed by the prompt string).
   * Empty string means the prompt is appended as a positional argument
   * (Claude's behavior).
   */
  promptFlag: string;
}

export interface AiLaunchOpts {
  unsafe?: boolean;
  resume?: boolean;
  promptFile?: string;
  /** Inline prompt (used by CLI `--prompt`). */
  initialPrompt?: string;
}

/**
 * Per-tool flag presets. Looked up by the binary in `aiCommand`. Users can
 * override any individual flag via `config.aiCommandFlags`.
 */
export const AI_TOOL_PRESETS: Record<string, {
  unsafe: string;
  resume: string;
  promptFile: string;
  prompt: string;
}> = {
  claude: {
    unsafe: '--dangerously-skip-permissions',
    resume: '--continue',
    promptFile: '--prompt-file',
    prompt: '', // positional
  },
  opencode: {
    unsafe: '', // no equivalent — permissions are configured elsewhere
    resume: '--continue',
    promptFile: '', // no file flag — content gets inlined via promptFlag
    prompt: '--prompt',
  },
};

/** Display names for the init picker. */
export const KNOWN_TOOLS = [
  { name: 'Claude Code (claude)', value: 'claude' },
  { name: 'OpenCode (opencode)', value: 'opencode' },
] as const;

/**
 * Resolve the configured AI tool. Falls back to the `claude` preset so default
 * behavior is preserved when no `aiCommand` is set.
 */
export function getAiTool(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'>): AiToolSpec {
  const command = (config.aiCommand ?? 'claude').trim();
  const parts = command.split(/\s+/).filter(Boolean);
  const cmd = parts[0] || 'claude';
  const baseArgs = parts.slice(1);
  const preset = AI_TOOL_PRESETS[cmd] ?? AI_TOOL_PRESETS.claude;
  const overrides = config.aiCommandFlags ?? {};
  return {
    cmd,
    baseArgs,
    unsafeFlag: overrides.unsafe ?? preset.unsafe,
    resumeFlag: overrides.resume ?? preset.resume,
    promptFileFlag: overrides.promptFile ?? preset.promptFile,
    promptFlag: overrides.prompt ?? preset.prompt,
  };
}

/** Build the final `{ cmd, args }` to spawn for the given launch options. */
export function buildAiLaunchArgs(tool: AiToolSpec, opts: AiLaunchOpts = {}): { cmd: string; args: string[] } {
  const args = [...tool.baseArgs];
  if (opts.unsafe && tool.unsafeFlag) args.push(tool.unsafeFlag);
  if (opts.resume && tool.resumeFlag) args.push(tool.resumeFlag);

  let inlinePrompt = opts.initialPrompt;
  if (opts.promptFile) {
    if (tool.promptFileFlag) {
      args.push(tool.promptFileFlag, opts.promptFile);
    } else if (tool.promptFlag) {
      // Tool has no prompt-file flag — read the file and pass inline instead.
      try { inlinePrompt = fs.readFileSync(opts.promptFile, 'utf-8'); }
      catch { /* leave inlinePrompt as-is */ }
    }
  }
  if (inlinePrompt) {
    if (tool.promptFlag) args.push(tool.promptFlag, inlinePrompt);
    else args.push(inlinePrompt);
  }
  return { cmd: tool.cmd, args };
}
