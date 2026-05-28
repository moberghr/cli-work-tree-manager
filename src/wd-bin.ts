import chalk from 'chalk';
import { run } from './cli.js';
import { installConsoleLogger, debug } from './core/logger.js';

installConsoleLogger();
debug('--- wd started', process.argv.slice(2).join(' '), '---');

if (!process.env.NO_COLOR && chalk.level === 0) {
  chalk.level = 1;
}

process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

run(['diff', ...process.argv.slice(2)]);
