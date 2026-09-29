import chalk from 'chalk';
import { run } from './cli.js';
import { installConsoleLogger, debug } from './core/logger.js';
import { withReporter } from './core/report.js';
import { consoleReporter } from './commands/shared/console-reporter.js';

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

// wd's stdout carries data only (the review markdown): core's reports go to stderr.
withReporter(consoleReporter('stderr'), () => run(['diff', ...process.argv.slice(2)]));
