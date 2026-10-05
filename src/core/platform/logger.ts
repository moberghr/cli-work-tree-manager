import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

let maxLogSize = 5 * 1024 * 1024; // 5MB, then debug.log → debug.log.1

let logPath: string | null = null;
/** A plain file descriptor, written synchronously: a line is on disk when
 *  debugLog returns (a buffered stream lost the last lines on exit), and
 *  rotation can close the file before renaming it — Windows refuses to
 *  rename a file that is still open. */
let logFd: number | null = null;
/** Bytes in the current file: its size at open plus what we wrote since. */
let logBytes = 0;

/** Tests shrink the cap to exercise rotation. */
export function setMaxLogSizeForTests(bytes: number): void {
  maxLogSize = bytes;
}

function rotate(file: string): void {
  const prev = file + '.1';
  try {
    fs.unlinkSync(prev);
  } catch {
    /* */
  }
  try {
    fs.renameSync(file, prev);
  } catch {
    /* another process has it open; next time */
  }
}

function ensureLog(): number | null {
  if (logFd !== null) return logFd;
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'debug.log');
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      /* file doesn't exist yet */
    }
    if (size > maxLogSize) {
      rotate(logPath);
      size = 0;
    }
    logFd = fs.openSync(logPath, 'a');
    logBytes = size;
    return logFd;
  } catch {
    return null;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

// Strip ANSI escape codes for clean log output
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function debugLog(level: 'INFO' | 'ERROR' | 'DEBUG' | 'WARN', ...args: unknown[]): void {
  const fd = ensureLog();
  if (fd === null) return;
  const msg = args.map((a) => (typeof a === 'string' ? stripAnsi(a) : JSON.stringify(a))).join(' ');
  const line = `${timestamp()} [${level}] ${msg}\n`;
  try {
    fs.writeSync(fd, line);
  } catch {
    return; // best effort: logging must never break the host
  }
  logBytes += Buffer.byteLength(line);
  // Rotate while running too: work web and the PTY host run for days, and
  // the cap used to be checked only when a process opened the log.
  if (logBytes > maxLogSize && logPath) {
    closeLog();
    rotate(logPath);
  }
}

/**
 * Patch console.log and console.error to also write to the debug log.
 * Call once at startup.
 */
export function installConsoleLogger(): void {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    debugLog('INFO', ...args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    debugLog('ERROR', ...args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    debugLog('WARN', ...args);
  };
}

/** Write a debug-only message (not shown to user). */
export function debug(...args: unknown[]): void {
  debugLog('DEBUG', ...args);
}

/** Get the log file path. */
export function getLogPath(): string {
  ensureLog();
  return logPath ?? path.join(getConfigDir(), 'debug.log');
}

/** Flush and close the log stream. */
export function closeLog(): void {
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* */
    }
    logFd = null;
  }
}
