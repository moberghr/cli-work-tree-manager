import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let logPath: string | null = null;
let logStream: fs.WriteStream | null = null;

function ensureLogStream(): fs.WriteStream | null {
  if (logStream) return logStream;
  try {
    const dir = getConfigDir();
    // Make sure the parent directory exists before opening a stream into
    // it — under tests (mocked homedir) or first-run conditions the .work
    // dir may not have been created yet, and createWriteStream's failure
    // is async (emits 'error') which would otherwise become an unhandled
    // exception in the host process.
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'debug.log');

    // Rotate if too large
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_SIZE) {
        const prev = logPath + '.1';
        try { fs.unlinkSync(prev); } catch { /* */ }
        fs.renameSync(logPath, prev);
      }
    } catch { /* file doesn't exist yet */ }

    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    // Best-effort logging — async stream errors must not crash the host.
    stream.on('error', () => { /* */ });
    logStream = stream;
    return logStream;
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
  const stream = ensureLogStream();
  if (!stream) return;
  const msg = args.map((a) => typeof a === 'string' ? stripAnsi(a) : JSON.stringify(a)).join(' ');
  stream.write(`${timestamp()} [${level}] ${msg}\n`);
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
  ensureLogStream();
  return logPath ?? path.join(getConfigDir(), 'debug.log');
}

/** Flush and close the log stream. */
export function closeLog(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
