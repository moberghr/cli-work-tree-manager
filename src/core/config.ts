import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface WorkConfig {
  worktreesRoot: string;
  repos: Record<string, string>;
  groups: Record<string, string[]>;
  copyFiles: string[];
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
