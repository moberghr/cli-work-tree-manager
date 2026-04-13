import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
   * Per-tool flag overrides. Defaults match Claude Code. Set any value to
   * an empty string to disable that flag for the configured tool.
   */
  aiCommandFlags?: {
    /** Flag for skipping permission checks. Default: "--dangerously-skip-permissions". */
    unsafe?: string;
    /** Flag for resuming the most recent session. Default: "--continue". */
    resume?: string;
    /** Flag for passing an initial prompt as a file path. Default: "--prompt-file". */
    promptFile?: string;
  };
  /** Editor command for opening worktrees. Default: "code" */
  editor?: string;
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
    throw new Error('Configuration not found. Run "work2 init" to set up.');
  }
  return config;
}
