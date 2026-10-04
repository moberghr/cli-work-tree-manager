import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { exportBundle, importBundle, MoveError, runningHere, unsavedWork } from '../core/move/move.js';
import { loadHistory } from '../core/sessions/history.js';

/**
 * `work move export <dir>` / `work move import <dir>` — take your sessions,
 * conversations and setup to another computer (core/move/move.ts).
 */
export const moveCommand: CommandModule = {
  command: 'move <action> <dir>',
  describe: 'Move work to another computer: export a bundle here, import it there',
  builder: (y) =>
    y
      .positional('action', { choices: ['export', 'import'] as const, describe: 'export a bundle here, or import one' })
      .positional('dir', { type: 'string', describe: 'The bundle folder (new for export)' })
      .option('force', { type: 'boolean', describe: 'export: even with work not pushed; import: replace the sessions here' })
      .option('repos-root', { type: 'string', describe: 'import: where the repos are on this computer (each in its folder name)' })
      .option('worktrees-root', { type: 'string', describe: 'import: where worktrees go on this computer' })
      .option('clone', { type: 'boolean', describe: "import: clone repos that aren't here from their origin" }),
  handler: async (argv) => {
    const dir = path.resolve(argv.dir as string);
    try {
      if (argv.action === 'export') {
        const unsaved = await unsavedWork(loadHistory());
        if (unsaved.length) {
          console.log(chalk.yellow("Work that's only on this computer (the other one gets worktrees from origin):"));
          for (const u of unsaved) console.log(`  ${u.session}: ${u.what}  ${chalk.gray(u.path)}`);
          if (!argv.force) {
            console.log(chalk.gray('Commit and push it (or ask its Claude), then export again — or --force to leave it behind.'));
            process.exitCode = 1;
            return;
          }
        }
        const r = exportBundle(dir);
        console.log(chalk.green(`Exported ${r.sessions} session(s) and ${r.transcripts} conversation file(s) to ${r.dir}`));
        console.log(chalk.gray('Copy the folder to the other computer and run `work move import <folder>` there (with work web stopped).'));
        return;
      }
      const running = await runningHere();
      if (running.length) {
        console.error(chalk.red(`Stop ${running.join(' and ')} first: an import replaces the database they hold.`));
        process.exitCode = 1;
        return;
      }
      const r = await importBundle(dir, {
        force: argv.force === true,
        clone: argv.clone === true,
        reposRoot: typeof argv['repos-root'] === 'string' ? path.resolve(argv['repos-root']) : undefined,
        worktreesRoot: typeof argv['worktrees-root'] === 'string' ? path.resolve(argv['worktrees-root']) : undefined,
      });
      console.log(chalk.green(`Imported ${r.sessions} session(s); ${r.transcripts} conversation file(s) put back for Claude.`));
      if (r.repos.cloned.length) console.log(`Cloned: ${r.repos.cloned.join(', ')}`);
      if (r.repos.missing.length)
        console.log(chalk.yellow(`Not on this computer: ${r.repos.missing.join(', ')} — clone them (or run again with --clone).`));
      if (r.worktrees.created.length) console.log(`Worktrees recreated: ${r.worktrees.created.join(', ')}`);
      for (const f of r.worktrees.failed) console.log(chalk.yellow(`  ${f.session}: ${f.error}`));
      console.log(chalk.gray('Start `work web`: sessions resume their conversations when you open them.'));
    } catch (err) {
      if (!(err instanceof MoveError)) throw err;
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  },
};
