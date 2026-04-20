import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import { App } from './App.js';
import { getConfigDir } from '../core/config.js';

/** Synchronous crash log — survives hard exits where the async stream doesn't flush. */
function crashLog(label: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    const line = `${new Date().toISOString()} [CRASH] ${label}: ${msg}\n`;
    fs.appendFileSync(path.join(getConfigDir(), 'debug.log'), line);
  } catch { /* last resort — nothing we can do */ }
}

export async function startDashboard(unsafe: boolean): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('work dash requires an interactive terminal');
    process.exit(1);
  }

  // Enter alternate screen buffer and hide cursor
  process.stdout.write('\x1B[?1049h\x1B[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const restore = () => {
    process.stdout.write('\x1B]0;\x07\x1B[?25h\x1B[?1049l');
  };

  try {
    const { waitUntilExit, unmount } = render(
      <App unsafe={unsafe} onExit={() => {
        unmount();
        restore();
        process.exit(0);
      }} />,
      {
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    process.on('exit', restore);
    process.on('SIGINT', () => { restore(); process.exit(0); });
    process.on('SIGTERM', () => { restore(); process.exit(0); });
    process.on('uncaughtException', (err) => {
      // node-pty throws async errors for already-exited PTYs — non-fatal
      if (err instanceof Error && err.message?.includes('pty that has already exited')) return;
      crashLog('uncaughtException', err);
      unmount();
      restore();
      console.error('work dash error:', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      crashLog('unhandledRejection', reason);
    });

    await waitUntilExit();
  } catch (err) {
    crashLog('catch', err);
    restore();
    console.error('work dash error:', err);
    process.exit(1);
  }
}
