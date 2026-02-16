import chalk from 'chalk';
import { run } from './cli.js';

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
  console.error(err);
  process.exit(1);
}

process.on('uncaughtException', handleFatalError);
process.on('unhandledRejection', handleFatalError);

run(process.argv.slice(2));
