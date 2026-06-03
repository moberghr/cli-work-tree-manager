import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * An opt-in shell command that runs when a session changes status. The command
 * runs with the session's directory as its cwd (passed as the spawn `cwd`
 * option, never interpolated into the command string).
 */
export interface StatusHook {
  on: 'idle' | 'needs_input';
  command: string;
}

export interface WorkConfig {
  worktreesRoot: string;
  repos: Record<string, string>;
  groups: Record<string, string[]>;
  copyFiles: string[];
  /**
   * AI tool command to launch in worktrees. May include extra args, e.g.
   * "claude" (default), "gemini", "codex", or "my-tool --some-flag".
   */
  aiCommand?: string;
  /**
   * Per-tool flag overrides. Defaults come from the preset matching the
   * binary in `aiCommand` (see AI_TOOL_PRESETS in core/ai-launcher.ts).
   * Set any value to an empty string to disable that flag for the configured tool.
   */
  aiCommandFlags?: {
    /** Flag for skipping permission checks. */
    unsafe?: string;
    /** Flag for resuming the most recent session. */
    resume?: string;
    /** Flag for passing an initial prompt as a file path. */
    promptFile?: string;
    /** Flag for passing an inline prompt; empty string = positional arg. */
    prompt?: string;
  };
  /** Editor command for opening worktrees. Default: "code" */
  editor?: string;
  /**
   * Range of dev-server ports to allocate to worktrees (inclusive).
   * Each worktree gets a stable port exposed as $PORT to the launched process.
   * Default when unset: { start: 3000, end: 3099 }.
   */
  portRange?: { start: number; end: number };
  /**
   * Opt-in desktop notifications. When true, the dashboard fires an OS
   * notification when a session goes idle or needs input. Default: off.
   */
  notifications?: boolean;
  /**
   * Opt-in shell commands run when a session changes status (idle /
   * needs_input). Each command runs with the session dir as its cwd.
   * Generalizes `notifications`; both paths work independently. Default: none.
   */
  statusHooks?: StatusHook[];
}

/** Lowest port we allow to be configured (avoid privileged ports < 1024). */
const MIN_PORT = 1024;
/** Highest valid TCP port. */
const MAX_PORT = 65535;

/**
 * Validate a configured port range. Returns the normalized range when it is a
 * pair of integers with `MIN_PORT <= start <= end <= MAX_PORT`, otherwise
 * undefined (callers then fall back to the default range). Rejects non-integers,
 * privileged/out-of-bounds ports, and reversed ranges.
 */
export function validatePortRange(
  value: unknown,
): { start: number; end: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < MIN_PORT || end > MAX_PORT) return undefined;
  if (start > end) return undefined;
  return { start, end };
}

export function getConfigDir(): string {
  const dir = path.join(os.homedir(), '.work');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): WorkConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      worktreesRoot: parsed.worktreesRoot ?? '',
      repos: parsed.repos ?? {},
      groups: parsed.groups ?? {},
      copyFiles: parsed.copyFiles ?? [],
      aiCommand: parsed.aiCommand,
      aiCommandFlags: parsed.aiCommandFlags,
      editor: parsed.editor,
      portRange: validatePortRange(parsed.portRange),
      notifications: parsed.notifications === true,
      statusHooks: Array.isArray(parsed.statusHooks) ? parsed.statusHooks : [],
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: WorkConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function ensureConfig(): WorkConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('Configuration not found. Run "work init" to set up.');
  }
  return config;
}
