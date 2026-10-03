import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { ensureConfig } from '../core/platform/config.js';
import { applyCleanup, scanCleanup } from '../core/cleanup/cleanup.js';
import { defaultCleanupDeps } from '../core/cleanup/cleanup-deps.js';
import { createBuildFoldersJob, scanBuildFolders } from '../core/cleanup/build-folders-scan.js';
import { defaultBuildFoldersDeps } from '../core/cleanup/build-folders-deps.js';
import { deleteMergedBranches, findMergedBranches } from '../core/cleanup/branch-tidy.js';
import { defaultBranchTidyDeps } from '../core/cleanup/branch-tidy-deps.js';
import type { CleanupAction, CleanupCandidate } from '../core/api-types.js';
import { timeAgo } from '../core/platform/format.js';

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

/** `work cleanup --build-folders [--apply [ids…]] [--json]` */
async function buildFoldersCommand(apply: boolean, ids: string[], json: boolean): Promise<void> {
  const deps = defaultBuildFoldersDeps();
  const list = await scanBuildFolders(deps);
  if (!apply) {
    if (json) {
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
      return;
    }
    const total = list.reduce((n, c) => n + c.bytes, 0);
    console.log(
      chalk.gray(`Build folders git ignores, in worktrees idle a week or more: ${(total / 1e9).toFixed(1)} GB in ${list.length}\n`),
    );
    for (const c of list) {
      const top =
        c.folders
          .slice(0, 3)
          .map((f) => f.path)
          .join(', ') + (c.folders.length > 3 ? ` +${c.folders.length - 3} more` : '');
      console.log(
        `  ${c.sessionId}  ${(c.bytes / 1e9).toFixed(2).padStart(6)} GB  ${c.target} ${c.branch}${c.baseCheckout ? chalk.cyan(' (repo checkout)') : ''}  ${chalk.gray(top)}`,
      );
    }
    if (list.length) console.log(chalk.gray('\nClear them: work cleanup --build-folders --apply [<id>…]'));
    return;
  }
  const chosen = ids.length ? ids : list.map((c) => c.sessionId);
  const results = await createBuildFoldersJob(deps).apply(chosen);
  if (json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  else
    for (const r of results)
      console.log(r.ok ? chalk.green(`  ✓ ${r.sessionId} — ${r.message}`) : chalk.yellow(`  ✗ ${r.sessionId} — ${r.message}`));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
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
      .option('action', {
        type: 'string',
        choices: ACTIONS,
        default: 'delete',
        describe: 'With --apply: what to do (a gone folder is always forgotten)',
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe: 'With --apply delete: also remove merged worktrees with uncommitted changes (lost)',
      })
      .option('branches', {
        type: 'boolean',
        default: false,
        describe:
          'Instead: local branches already merged (or squash-merged: a merged PR whose head is the tip); with --apply, delete them (checked again)',
      })
      .option('build-folders', {
        type: 'boolean',
        default: false,
        describe: 'Instead: build output (node_modules, bin/obj, .next, …) git ignores, in worktrees idle a week+; with --apply, clear it',
      }),
  handler: async (argv) => {
    ensureConfig();
    if (argv.branches) {
      const deps = defaultBranchTidyDeps();
      const list = await findMergedBranches(deps);
      if (!argv.apply) {
        if (argv.json) process.stdout.write(JSON.stringify(list, null, 2) + '\n');
        else {
          for (const b of list)
            console.log(
              `  ${b.repo.padEnd(18)} ${b.branch}  ${chalk.gray(b.reason === 'merged' ? 'merged' : `squash-merged${b.prNumber ? ` #${b.prNumber}` : ''}`)}${b.archivedSession ? chalk.yellow('  (an archived session uses it)') : ''}`,
            );
          if (list.length) console.log(chalk.gray('\nDelete them: work cleanup --branches --apply'));
          else console.log(chalk.gray('No merged local branches.'));
        }
        return;
      }
      const results = await deleteMergedBranches(
        list.filter((b) => !b.archivedSession).map(({ repo, branch, tip }) => ({ repo, branch, tip })),
        deps,
      );
      if (argv.json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      else
        for (const r of results)
          console.log(
            r.ok ? chalk.green(`  ✓ ${r.repo} ${r.branch} — ${r.message}`) : chalk.yellow(`  ✗ ${r.repo} ${r.branch} — ${r.message}`),
          );
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    if (argv['build-folders']) {
      await buildFoldersCommand(argv.apply as boolean, (argv.ids as string[] | undefined) ?? [], argv.json as boolean);
      return;
    }
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
        for (const r of results)
          console.log(r.ok ? chalk.green(`  ✓ ${r.sessionId} — ${r.message}`) : chalk.yellow(`  ✗ ${r.sessionId} — ${r.message}`));
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
