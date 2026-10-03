import chalk from 'chalk';
import yargs from 'yargs';
import { configCommand } from './commands/config.js';
import { initCommand } from './commands/init.js';
import { treeCommand } from './commands/tree.js';
import { removeCommand } from './commands/remove.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { recentCommand } from './commands/recent.js';
import { resumeCommand } from './commands/resume.js';
import { pruneCommand } from './commands/prune.js';
import { syncCommand } from './commands/sync.js';
import { completionCommand } from './commands/completion.js';
import { todoCommand } from './commands/todo.js';
import { hydrateCommand } from './commands/hydrate.js';
import { diffCommand } from './commands/diff.js';
import { webCommand } from './commands/web.js';
import { hookCommand } from './commands/hook.js';
import { runCommand } from './commands/run.js';
import { broadcastCommand } from './commands/broadcast.js';
import { attachCommand } from './commands/attach.js';
import { ptyHostCommand } from './commands/pty-host.js';
import { stateCommand } from './commands/state.js';
import { installSkillsCommand } from './commands/install-skills.js';
import { sessionsCommand } from './commands/sessions.js';
import { digestCommand } from './commands/digest.js';
import { cleanupCommand } from './commands/cleanup.js';
import { overlapsCommand } from './commands/overlaps.js';
import { searchCommand } from './commands/search.js';
import { prCommand } from './commands/pr.js';
import { forkCommand } from './commands/fork.js';
import { snoozeCommand } from './commands/snooze.js';
import { pinCommand } from './commands/pin.js';
import { sectionCommand } from './commands/section.js';
import { catchupCommand } from './commands/catchup.js';
import { updateCommand } from './commands/update.js';
import { noteCommand } from './commands/note.js';
import { blockCommand } from './commands/block.js';
import { timeCommand } from './commands/time.js';
import { readCommand } from './commands/read.js';
import { screenCommand } from './commands/screen.js';
import { sendCommand } from './commands/send.js';
import { waitCommand } from './commands/wait.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { answerCommand } from './commands/answer.js';
import { completionHandler } from './completions/index.js';
import { VERSION } from './version.js';

function showHelp() {
  console.log('');
  console.log(chalk.cyan(`Work - Git Worktree Manager ${chalk.gray(`v${VERSION}`)}`));
  console.log(chalk.cyan('============================'));
  console.log('');
  console.log(chalk.green('Usage:'));
  console.log('  work init                                          - Set up configuration');
  console.log('  work config <action>                               - Manage configuration');
  console.log('  work list [project|group]                          - List all worktrees');
  console.log('  work tree|t <project|group> <branch>               - Create/switch to worktree');
  console.log('  work tree <project|group> <branch> --base <branch> - Create from a specific base branch');
  console.log('  work tree <project|group> <branch> --open          - Also open VS Code');
  console.log('  work tree <project|group> <branch> --unsafe        - Skip AI tool permission checks');
  console.log('  work remove <project|group> <branch>               - Remove worktree');
  console.log('  work remove <project|group> <branch> --force       - Force remove worktree');
  console.log('  work status [project|group] [branch]               - Show worktree status');
  console.log('  work status --prune                                - Remove stale entries');
  console.log('  work recent [count]                                - List recent sessions');
  console.log('  work resume                                        - Resume a recent session');
  console.log('  work sessions [project] [--json] [--changes]      - Every session with its status, as the dashboard shows it');
  console.log('  work digest [--since today|yesterday|week]         - What each session did (Markdown for a standup; --json)');
  console.log('  work overlaps [--json]                             - Live sessions changing the same files');
  console.log('  work cleanup [--json]                              - Which worktrees can go, and why');
  console.log('  work cleanup --apply <id...> [--action …]          - Remove / archive / forget them, after a fresh check');
  console.log('  work web                                           - Browser dashboard (one tab, every session)');
  console.log('  work prune                                         - Remove merged worktrees');
  console.log('  work prune --force                                 - Remove all merged (no prompt)');
  console.log('  work sync                                          - Fetch all repos and prune merged (non-interactive)');
  console.log('  work sync --dry-run                                - Show what sync would prune, remove nothing');
  console.log('  work sync --force                                  - Also remove merged worktrees with uncommitted changes');
  console.log('  work sync --include-squash                         - Also prune squash-merged branches (lower confidence)');
  console.log('  work hydrate                                       - Seed history from worktrees on disk');
  console.log('  work diff [base]                                   - Open a GitHub-PR-style diff in your browser');
  console.log('  work run <cmd...>                                  - Run a command in every worktree');
  console.log('  work run <cmd...> --target <alias> --parallel      - Filter + run concurrently');
  console.log('  work broadcast <prompt>                            - Queue a prompt to every live session');
  console.log('  work attach [target] [branch]                      - Attach this terminal to a session (Ctrl+] detaches)');
  console.log('  work todo                                          - List tasks');
  console.log('  work todo add <text>                               - Add a task');
  console.log('  work todo done <id>                                - Mark task complete');
  console.log('  work todo rm <id>                                  - Remove a task');
  console.log('  work completion --install                          - Install shell completions');
  console.log('');
  console.log(chalk.green('Config Actions:'));
  console.log('  work config add <alias> <path>                     - Add a repository');
  console.log('  work config remove <alias>                         - Remove a repository');
  console.log('  work config list                                   - List repos and groups');
  console.log('  work config group add <name> <alias1> <alias2> ... - Create a repository group');
  console.log('  work config group remove <name>                    - Remove a repository group');
  console.log('  work config group regen <name>                     - Regenerate group CLAUDE.md');
  console.log('');
  console.log(chalk.green('Examples:'));
  console.log('  work init');
  console.log('  work list');
  console.log('  work list ai');
  console.log('  work tree ai feature/login');
  console.log('  work tree frontend feature/login --open');
  console.log('  work tree ai feature/hotfix --unsafe');
  console.log('  work remove ai feature/login');
  console.log('');
  console.log(chalk.gray('  # Groups (multi-repo worktrees):'));
  console.log('  work config group add fullstack api frontend');
  console.log('  work tree fullstack feature/login');
  console.log('  work remove fullstack feature/login');
  console.log('');
}

export function run(argv: string[]) {
  // Show custom colored help when no args given
  if (argv.length === 0) {
    showHelp();
    return;
  }

  const cli = yargs(argv)
    .scriptName('work')
    .usage('$0 <command> [options]')
    .command(initCommand)
    .command(configCommand)
    .command(treeCommand)
    .command(removeCommand)
    .command(forkCommand)
    .command(updateCommand)
    .command(catchupCommand)
    .command(snoozeCommand)
    .command(pinCommand)
    .command(sectionCommand)
    .command(noteCommand)
    .command(blockCommand)
    .command(timeCommand)
    .command(readCommand)
    .command(screenCommand)
    .command(sendCommand)
    .command(waitCommand)
    .command(startCommand)
    .command(stopCommand)
    .command(answerCommand)
    .command(listCommand)
    .command(statusCommand)
    .command(recentCommand)
    .command(resumeCommand)
    .command(sessionsCommand)
    .command(digestCommand)
    .command(cleanupCommand)
    .command(overlapsCommand)
    .command(searchCommand)
    .command(prCommand)
    .command(pruneCommand)
    .command(syncCommand)
    .command(todoCommand)
    .command(hydrateCommand)
    .command(diffCommand)
    .command(webCommand)
    .command(hookCommand)
    .command(runCommand)
    .command(broadcastCommand)
    .command(attachCommand)
    .command(ptyHostCommand)
    .command(stateCommand)
    .command(installSkillsCommand)
    .command(completionCommand)
    // Hidden: yargs uses this internally for --get-yargs-completions
    .completion('__completions', false as any, completionHandler)
    .demandCommand(1, 'You need to specify a command. Run work --help for usage.')
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
    .version(VERSION)
    .alias('v', 'version')
    .wrap(Math.min(100, process.stdout.columns || 80));

  cli.parse();
}
