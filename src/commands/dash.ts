import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { startDashboard } from '../tui-ink/index.js';

export const dashCommand: CommandModule = {
  command: 'dash',
  describe: 'Interactive dashboard for all worktree sessions',
  builder: (yargs) =>
    yargs.option('unsafe', {
      describe: 'Launch the AI tool with its skip-permissions flag',
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    ensureConfig();
    await startDashboard(argv.unsafe as boolean);
  },
};
