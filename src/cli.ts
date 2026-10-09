import chalk from 'chalk';
import yargs from 'yargs';
import type { CommandModule } from 'yargs';
import { completionHandler } from './completions/index.js';
import { VERSION } from './version.js';

/**
 * Every command, in the order `work --help` lists them, by the words that
 * run it. `work <verb>` imports only that verb's module: loading all of them
 * (node-pty, the servers, SQLite, the prompts) made every command — and
 * Claude's `work sessions --json` — start in ~430 ms. Help, completion and
 * anything unknown load them all. A test keeps the words equal to the
 * commands' own names and aliases.
 */
export const COMMANDS: Array<{ names: string[]; load: () => Promise<CommandModule> }> = [
  { names: ['init'], load: async () => (await import('./commands/init.js')).initCommand },
  { names: ['config'], load: async () => (await import('./commands/config.js')).configCommand },
  { names: ['tree', 't'], load: async () => (await import('./commands/tree.js')).treeCommand },
  { names: ['remove'], load: async () => (await import('./commands/remove.js')).removeCommand },
  { names: ['fork'], load: async () => (await import('./commands/fork.js')).forkCommand },
  { names: ['update'], load: async () => (await import('./commands/update.js')).updateCommand },
  { names: ['catchup'], load: async () => (await import('./commands/catchup.js')).catchupCommand },
  { names: ['snooze'], load: async () => (await import('./commands/snooze.js')).snoozeCommand },
  { names: ['pin'], load: async () => (await import('./commands/pin.js')).pinCommand },
  { names: ['section'], load: async () => (await import('./commands/section.js')).sectionCommand },
  { names: ['note'], load: async () => (await import('./commands/note.js')).noteCommand },
  { names: ['block'], load: async () => (await import('./commands/block.js')).blockCommand },
  { names: ['time'], load: async () => (await import('./commands/time.js')).timeCommand },
  { names: ['read'], load: async () => (await import('./commands/read.js')).readCommand },
  { names: ['screen'], load: async () => (await import('./commands/screen.js')).screenCommand },
  { names: ['send'], load: async () => (await import('./commands/send.js')).sendCommand },
  { names: ['wait'], load: async () => (await import('./commands/wait.js')).waitCommand },
  { names: ['start'], load: async () => (await import('./commands/start.js')).startCommand },
  { names: ['stop'], load: async () => (await import('./commands/stop.js')).stopCommand },
  { names: ['answer'], load: async () => (await import('./commands/answer.js')).answerCommand },
  { names: ['list'], load: async () => (await import('./commands/list.js')).listCommand },
  { names: ['status'], load: async () => (await import('./commands/status.js')).statusCommand },
  { names: ['recent'], load: async () => (await import('./commands/recent.js')).recentCommand },
  { names: ['resume'], load: async () => (await import('./commands/resume.js')).resumeCommand },
  { names: ['sessions'], load: async () => (await import('./commands/sessions.js')).sessionsCommand },
  { names: ['digest'], load: async () => (await import('./commands/digest.js')).digestCommand },
  { names: ['cleanup'], load: async () => (await import('./commands/cleanup.js')).cleanupCommand },
  { names: ['overlaps'], load: async () => (await import('./commands/overlaps.js')).overlapsCommand },
  { names: ['search'], load: async () => (await import('./commands/search.js')).searchCommand },
  { names: ['pr'], load: async () => (await import('./commands/pr.js')).prCommand },
  { names: ['timesheet'], load: async () => (await import('./commands/timesheet.js')).timesheetCommand },
  { names: ['prune'], load: async () => (await import('./commands/prune.js')).pruneCommand },
  { names: ['sync'], load: async () => (await import('./commands/sync.js')).syncCommand },
  { names: ['todo'], load: async () => (await import('./commands/todo.js')).todoCommand },
  { names: ['hydrate'], load: async () => (await import('./commands/hydrate.js')).hydrateCommand },
  { names: ['diff'], load: async () => (await import('./commands/diff.js')).diffCommand },
  { names: ['web'], load: async () => (await import('./commands/web.js')).webCommand },
  { names: ['hook'], load: async () => (await import('./commands/hook.js')).hookCommand },
  { names: ['run'], load: async () => (await import('./commands/run.js')).runCommand },
  { names: ['broadcast'], load: async () => (await import('./commands/broadcast.js')).broadcastCommand },
  { names: ['attach', 'a'], load: async () => (await import('./commands/attach.js')).attachCommand },
  { names: ['pty-host'], load: async () => (await import('./commands/pty-host.js')).ptyHostCommand },
  { names: ['state'], load: async () => (await import('./commands/state.js')).stateCommand },
  { names: ['move'], load: async () => (await import('./commands/move.js')).moveCommand },
  { names: ['install-skills'], load: async () => (await import('./commands/install-skills.js')).installSkillsCommand },
  { names: ['completion'], load: async () => (await import('./commands/completion.js')).completionCommand },
];

/** The commands to register for these arguments: the one named, else all. */
export async function commandsFor(argv: string[]): Promise<CommandModule[]> {
  const one = COMMANDS.find((c) => c.names.includes(argv[0] ?? ''));
  return Promise.all((one ? [one] : COMMANDS).map((c) => c.load()));
}

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

export async function run(argv: string[]): Promise<void> {
  // Show custom colored help when no args given
  if (argv.length === 0) {
    showHelp();
    return;
  }

  let cli = yargs(argv).scriptName('work').usage('$0 <command> [options]');
  for (const c of await commandsFor(argv)) cli = cli.command(c);
  cli = cli
    // Hidden: yargs uses this internally for --get-yargs-completions
    .completion('__completions', false, completionHandler)
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

  // Async handlers' failures land in .fail() above (and the fatal handlers in bin.ts).
  void cli.parse();
}
