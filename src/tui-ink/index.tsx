import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export async function startDashboard(unsafe: boolean): Promise<void> {
  // Enter alternate screen buffer and hide cursor
  process.stdout.write('\x1B[?1049h\x1B[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const restore = () => {
    process.stdout.write('\x1B]0;\x07\x1B[?25h\x1B[?1049l');
  };

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
    restore();
    console.error('Uncaught exception:', err);
    process.exit(1);
  });

  await waitUntilExit();
}
