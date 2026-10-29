import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** `~/.work`, never made: for what only reads (an install must write nothing there). */
export function configDirPath(): string {
  return path.join(os.homedir(), '.work');
}

/** `~/.work`, made when missing. Its own module (config.ts re-exports it) so the logger can find it without importing config, which reports through the logger. */
export function getConfigDir(): string {
  const dir = path.join(os.homedir(), '.work');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
