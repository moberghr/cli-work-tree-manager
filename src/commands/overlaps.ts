import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { scanChanges } from '../core/diff/overlap-scan.js';

export const overlapsCommand: CommandModule = {
  command: 'overlaps',
  describe: 'Live sessions that change the same files of a repo (they will conflict on merge); --json',
  builder: (yargs) => yargs.option('json', { type: 'boolean', default: false, describe: 'As JSON: session id → overlaps' }),
  handler: async (argv) => {
    const history = loadHistory();
    const { overlaps } = await scanChanges(history);
    if (argv.json) {
      process.stdout.write(JSON.stringify(Object.fromEntries(overlaps), null, 2) + '\n');
      return;
    }
    if (overlaps.size === 0) {
      console.log(chalk.green('No two live sessions change the same file.'));
      return;
    }
    // Each pair once.
    const seen = new Set<string>();
    for (const s of history) {
      const id = sessionIdFor(s);
      for (const o of overlaps.get(id) ?? []) {
        const pair = [id, o.sessionId].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        console.log(
          chalk.yellow(`⚠ ${s.target} · ${s.branch}  ↔  ${o.target} · ${o.branch}  (${o.count} file${o.count === 1 ? '' : 's'})`),
        );
        for (const f of o.files) console.log(chalk.gray(`    ${f.repo}/${f.path}`));
        if (o.count > o.files.length) console.log(chalk.gray(`    …and ${o.count - o.files.length} more`));
      }
    }
  },
};
