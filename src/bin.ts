import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { installConsoleLogger, debug } from './core/logger.js';
import { getConfigDir } from './core/config.js';

// Install debug logging — all console.log/error/warn also write to ~/.work/debug.log
installConsoleLogger();
// Not for hooks: Claude runs several per turn in every session, and a
// banner each made most of the log. What a hook actually logs still lands.
if (process.argv[2] !== 'hook') debug('--- work started', process.argv.slice(2).join(' '), '---');

// Force color support — this is an interactive CLI, and some Windows terminals
// (e.g. PowerShell via conhost) don't set isTTY on spawned .cmd shims.
if (!process.env.NO_COLOR && chalk.level === 0) {
  chalk.level = 1;
}

function handleFatalError(err: unknown): void {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(0);
  }
  // node-pty can throw async errors for already-exited PTYs (the PTY host) — non-fatal
  if (err instanceof Error && err.message?.includes('pty that has already exited')) {
    try {
      fs.appendFileSync(path.join(getConfigDir(), 'debug.log'),
        `${new Date().toISOString()} [WARN] Ignored async node-pty error: ${err.message}\n`);
    } catch { /* */ }
    return;
  }
  try {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    fs.appendFileSync(path.join(getConfigDir(), 'debug.log'),
      `${new Date().toISOString()} [FATAL] handleFatalError: ${msg}\n`);
  } catch { /* */ }
  console.error(err);
  process.exit(1);
}

process.on('uncaughtException', handleFatalError);
process.on('unhandledRejection', handleFatalError);

// Claude runs `work hook <event>` several times per turn, each with a 5 s
// timeout. The full CLI statically loads every command — node-pty, the web
// and PTY-host servers, SQLite — so a hook paid for all of it on every
// event. Hooks load only their own module.
const args = process.argv.slice(2);
if (args[0] === 'hook') {
  const { runHookEvent } = await import('./commands/hook.js');
  await runHookEvent(args[1]);
} else {
  const { run } = await import('./cli.js');
  run(args);
}
