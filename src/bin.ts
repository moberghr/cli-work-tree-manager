import chalk from 'chalk';
import { run } from './cli.js';

// Force color support — this is an interactive CLI, and some Windows terminals
// (e.g. PowerShell via conhost) don't set isTTY on spawned .cmd shims.
if (!process.env.NO_COLOR && chalk.level === 0) {
  chalk.level = 1;
}

run(process.argv.slice(2));
