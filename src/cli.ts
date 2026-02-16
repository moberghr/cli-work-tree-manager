import chalk from 'chalk';
import yargs from 'yargs';
import { configCommand } from './commands/config.js';
import { initCommand } from './commands/init.js';
import { treeCommand } from './commands/tree.js';
import { removeCommand } from './commands/remove.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { recentCommand } from './commands/recent.js';
import { pruneCommand } from './commands/prune.js';
import { completionCommand } from './commands/completion.js';
import { completionHandler } from './completions/index.js';

function showHelp() {
  console.log('');
  console.log(chalk.cyan('Work - Git Worktree Manager'));
  console.log(chalk.cyan('============================'));
  console.log('');
  console.log(chalk.green('Usage:'));
  console.log('  work2 init                                          - Set up configuration');
  console.log('  work2 config <action>                               - Manage configuration');
  console.log('  work2 list [project|group]                          - List all worktrees');
  console.log('  work2 tree <project|group> <branch>                 - Create/switch to worktree');
  console.log('  work2 tree <project|group> <branch> --open          - Also open VS Code');
  console.log('  work2 tree <project|group> <branch> --unsafe        - Skip Claude permission checks');
  console.log('  work2 remove <project|group> <branch>               - Remove worktree');
  console.log('  work2 remove <project|group> <branch> --force       - Force remove worktree');
  console.log('  work2 status [project|group] [branch]               - Show worktree status');
  console.log('  work2 status --prune                                - Remove stale entries');
  console.log('  work2 recent [count]                                - List recent sessions');
  console.log('  work2 recent --resume                               - Resume a session');
  console.log('  work2 prune                                         - Remove merged worktrees');
  console.log('  work2 prune --force                                 - Remove all merged (no prompt)');
  console.log('  work2 completion --install                          - Install shell completions');
  console.log('');
  console.log(chalk.green('Config Actions:'));
  console.log('  work2 config add <alias> <path>                     - Add a repository');
  console.log('  work2 config addgroup <name> <alias1> <alias2> ...  - Create a repository group');
  console.log('  work2 config removegroup <name>                     - Remove a repository group');
  console.log('  work2 config regengroup <name>                      - Regenerate group CLAUDE.md');
  console.log('  work2 config list                                   - List repos and groups');
  console.log('');
  console.log(chalk.green('Examples:'));
  console.log('  work2 init');
  console.log('  work2 list');
  console.log('  work2 list ai');
  console.log('  work2 tree ai feature/login');
  console.log('  work2 tree frontend feature/login --open');
  console.log('  work2 tree ai feature/hotfix --unsafe');
  console.log('  work2 remove ai feature/login');
  console.log('');
  console.log(chalk.gray('  # Groups (multi-repo worktrees):'));
  console.log('  work2 config addgroup fullstack api frontend');
  console.log('  work2 tree fullstack feature/login');
  console.log('  work2 remove fullstack feature/login');
  console.log('  work2 config regengroup fullstack');
  console.log('');
}

export function run(argv: string[]) {
  // Show custom colored help when no args given
  if (argv.length === 0) {
    showHelp();
    return;
  }

  const cli = yargs(argv)
    .scriptName('work2')
    .usage('$0 <command> [options]')
    .command(initCommand)
    .command(configCommand)
    .command(treeCommand)
    .command(removeCommand)
    .command(listCommand)
    .command(statusCommand)
    .command(recentCommand)
    .command(pruneCommand)
    .command(completionCommand)
    // Hidden: yargs uses this internally for --get-yargs-completions
    .completion('__completions', false as any, completionHandler)
    .demandCommand(1, 'You need to specify a command. Run work2 --help for usage.')
    .strict()
    .fail((msg, err, yargs) => {
      if (err?.name === 'ExitPromptError') {
        console.log('\nCancelled.');
        process.exit(0);
      }
      if (msg) {
        yargs.showHelp();
        console.error('\n' + msg);
      }
      if (err) console.error(err);
      process.exit(1);
    })
    .help()
    .alias('h', 'help')
    .version()
    .alias('v', 'version')
    .wrap(Math.min(100, process.stdout.columns || 80));

  cli.parse();
}
