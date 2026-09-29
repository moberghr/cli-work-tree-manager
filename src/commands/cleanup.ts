import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/config.js';
import { applyCleanup, scanCleanup } from '../core/cleanup.js';
import { defaultCleanupDeps } from '../core/cleanup-deps.js';
import type { CleanupAction, CleanupCandidate } from '../core/api-types.js';
import { timeAgo } from '../utils/format.js';

const ACTIONS: CleanupAction[] = ['delete', 'archive', 'forget'];

function printCandidates(list: CleanupCandidate[]): void {
  const sections: Array<[string, CleanupCandidate[]]> = [
    ['Safe to remove', list.filter((c) => c.verdict === 'merged' || c.verdict === 'gone')],
    ['Has work of its own (never removed; archive after a week quiet)', list.filter((c) => c.verdict === 'work' || c.verdict === 'dirty')],
  ];
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    console.log(chalk.bold(`${title} (${items.length})`));
    for (const c of items) {
      const act = c.suggested ? chalk.cyan(c.suggested.padEnd(7)) : chalk.gray('—'.padEnd(7));
      console.log(`  ${act} ${chalk.gray(c.target)} ${c.branch}  ${chalk.gray(timeAgo(c.lastActive))}  ${c.reason}`);
      console.log(chalk.gray(`          ${c.sessionId}`));
    }
    console.log('');
  }
}

export const cleanupCommand: CommandModule = {
  command: 'cleanup [ids..]',
  describe: 'Which worktrees can go, and why (--json); --apply <ids> removes, archives or forgets them after a fresh check',
  builder: (yargs) =>
    yargs
      .positional('ids', { type: 'string', array: true, describe: 'With --apply: the ids to act on (from the list)' })
      .option('json', { type: 'boolean', default: false, describe: 'The candidates as JSON' })
      .option('fetch', { type: 'boolean', default: true, describe: 'Fetch the repos first (--no-fetch to skip)' })
      .option('apply', { type: 'boolean', default: false, describe: 'Act on the given ids' })
      .option('action', { type: 'string', choices: ACTIONS, default: 'delete', describe: 'With --apply: what to do (a gone folder is always forgotten)' })
      .option('force', { type: 'boolean', default: false, describe: 'With --apply delete: also remove merged worktrees with uncommitted changes (lost)' }),
  handler: async (argv) => {
    ensureConfig();
    const deps = defaultCleanupDeps();
    if (argv.apply) {
      const ids = (argv.ids as string[] | undefined) ?? [];
      if (ids.length === 0) throw new Error('--apply needs the ids to act on (see `work cleanup`).');
      const byId = new Map((await deps.sessions()).map((s) => [s.id, s]));
      const action = argv.action as CleanupAction;
      const items = ids.map((id) => {
        const s = byId.get(id);
        const gone = !!s && s.paths.every((p) => !fs.existsSync(p));
        return { sessionId: id, action: action === 'delete' && gone ? ('forget' as const) : action };
      });
      const results = await applyCleanup(deps, items, { force: argv.force as boolean });
      if (argv.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      } else {
        for (const r of results) console.log(r.ok ? chalk.green(`  ✓ ${r.sessionId} — ${r.message}`) : chalk.yellow(`  ✗ ${r.sessionId} — ${r.message}`));
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    if (!argv.json) console.log(chalk.gray(argv.fetch ? 'Fetching and checking worktrees…\n' : 'Checking worktrees…\n'));
    const scan = await scanCleanup(deps, { fetch: argv.fetch as boolean });
    if (argv.json) {
      process.stdout.write(JSON.stringify(scan, null, 2) + '\n');
      return;
    }
    for (const f of scan.fetchFailed) console.log(chalk.yellow(`Could not fetch ${f.alias}; its worktrees were not checked: ${f.error}`));
    if (scan.candidates.length === 0) {
      console.log(chalk.green(`Nothing to clean up (${scan.checked} checked).`));
      return;
    }
    printCandidates(scan.candidates);
    console.log(chalk.gray('Act on some: work cleanup --apply <id> [<id>…] [--action delete|archive|forget]'));
  },
};
