import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startWebServer } from '../core/web-server.js';
import { openUrl } from '../utils/platform.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

export const webCommand: CommandModule = {
  command: 'web',
  describe:
    'Open the browser dashboard: every worktree session in one tab. Blocks until Ctrl+C.',
  builder: (yargs) =>
    yargs.option('open', {
      type: 'boolean',
      default: true,
      describe: 'Auto-open the dashboard in the default browser. Use --no-open to skip.',
    }),
  handler: async (argv) => {
    const handle = await startWebServer();
    // Publish the URL where other local tools can find it (mirrors the
    // `wd -c` review pattern).
    const urlFile = path.join(os.homedir(), '.work', 'web.url');
    try {
      fs.mkdirSync(path.dirname(urlFile), { recursive: true });
      fs.writeFileSync(urlFile, handle.url);
    } catch { /* */ }

    info(chalk.gray(`work web running at ${handle.url}`));
    info(chalk.gray('Press Ctrl+C to stop.'));
    if (argv.open) openUrl(handle.url);

    const shutdown = () => {
      info(chalk.gray('\nStopping work web.'));
      try { fs.unlinkSync(urlFile); } catch { /* */ }
      handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
  },
};
