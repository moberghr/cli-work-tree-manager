import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { exportLegacyState, stateSummary } from '../core/platform/db-export.js';

/**
 * `work state` — look inside ~/.work/state.db, or export it as the old JSON
 * files (`--export <dir>`) for a downgrade or for reading by hand.
 */
export const stateCommand: CommandModule = {
  command: 'state',
  describe: 'Show what ~/.work/state.db holds, or export it as JSON files',
  builder: (y) =>
    y.option('export', {
      type: 'string',
      describe: 'Write every record out in the pre-SQLite JSON layout into this folder',
    }),
  handler: (argv) => {
    const dir = argv.export as string | undefined;
    if (dir) {
      const out = path.resolve(dir);
      const files = exportLegacyState(out);
      console.log(chalk.green(`Exported ${files.length} file(s) to ${out}`));
      console.log(chalk.gray('To run an older work on them: stop work web and the PTY host, then copy them into ~/.work.'));
      return;
    }
    const s = stateSummary();
    console.log(`${chalk.bold('state.db')}  ${s.file}`);
    console.log(chalk.gray(`schema v${s.schemaVersion}${s.migratedAt ? `, created ${s.migratedAt}` : ''}`));
    const width = Math.max(...Object.keys(s.counts).map((k) => k.length));
    for (const [table, n] of Object.entries(s.counts)) console.log(`  ${table.padEnd(width)}  ${n}`);
  },
};
