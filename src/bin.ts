import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { run } from './cli.js';
import { installConsoleLogger, debug } from './core/logger.js';
import { getConfigDir } from './core/config.js';

// Install debug logging — all console.log/error/warn also write to ~/.work/debug.log
installConsoleLogger();
debug('--- work started', process.argv.slice(2).join(' '), '---');

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
  // node-pty can throw async errors for already-exited PTYs — non-fatal in dash mode
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

run(process.argv.slice(2));
