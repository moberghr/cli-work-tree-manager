import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { askCatchUp, catchUpFacts } from '../core/conversations/catch-up-deps.js';
import { catchUp } from '../core/conversations/catch-up.js';
import { forkSession } from '../core/sessions/fork.js';
import { defaultForkDeps, uncommittedFiles } from '../core/sessions/fork-deps.js';
import { findSession, loadHistory } from '../core/sessions/history.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { startSessionWithPrompt } from '../core/sessions/session-start.js';
import { attachSession } from './shared/attach-session.js';

/**
 * `work fork <new-branch>` — the dashboard's Fork… (core/fork.ts) from a
 * terminal: a new branch and worktree from where this session is, its Claude
 * started with a summary of this conversation; then this terminal is
 * attached to it, as `work tree` does (`--no-attach`: start it and leave it).
 */
export const forkCommand: CommandModule = {
  command: 'fork <branch>',
  describe: "Fork the current session: a new branch from where it is, its Claude given a summary of this conversation",
  builder: (yargs) =>
    yargs
      .positional('branch', { type: 'string', demandOption: true, describe: 'The new branch' })
      .option('target', { type: 'string', describe: 'The session to fork: its repo or group (default: the session for this folder)' })
      .option('from', { type: 'string', describe: "With --target: the session's branch" })
      .option('prompt', { type: 'string', describe: 'What to try in the fork (default: read the summary and wait)' })
      .option('name', { type: 'string', describe: 'A name for the new session' })
      .option('attach', { type: 'boolean', default: true, describe: 'Attach this terminal to the new Claude (--no-attach: start it in the PTY host and return)' }),
  handler: async (argv) => {
    const history = loadHistory();
    const target = argv.target as string | undefined;
    const from = argv.from as string | undefined;
    if (!!target !== !!from) {
      console.error(chalk.red('Give both --target and --from, or neither (the session for this folder).'));
      process.exitCode = 1;
      return;
    }
    const parent = target && from ? findSession(history, target, from) : findSessionForCwd(process.cwd(), history);
    if (!parent) {
      console.error(chalk.red(target ? `No session for ${target} ${from}.` : 'This folder is not inside a work session: pass --target and --from.'));
      process.exitCode = 1;
      return;
    }
    const branch = argv.branch as string;
    const attach = argv.attach !== false;
    let firstPrompt: string | null = null;
    console.log(chalk.cyan(`Forking ${parent.target} · ${parent.branch} into ${branch}…`));
    const r = await forkSession(
      parent,
      { branch, prompt: argv.prompt as string | undefined, name: argv.name as string | undefined },
      defaultForkDeps({
        summarize: async (s) => {
          console.log(chalk.gray('Writing a summary of the conversation…'));
          return (await catchUp(s, askCatchUp, catchUpFacts(sessionIdFor(s))))?.text ?? null;
        },
        uncommitted: uncommittedFiles,
        // Attaching starts it with the prompt (below); otherwise the host starts it now.
        start: async (id, prompt) => {
          firstPrompt = prompt;
          if (!attach) await startSessionWithPrompt(id, prompt);
        },
      }),
    );
    if (!r.ok) {
      console.error(chalk.red(`Not forked: ${r.error}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Forked into ${r.paths.join(', ')}`) + chalk.gray(r.summarized ? ' — its Claude gets a summary of this conversation.' : ' — no recent conversation to summarize.'));
    const fork = findSession(loadHistory(), parent.target, branch);
    if (r.startError || !fork) {
      console.error(chalk.yellow(`Its Claude didn't start: ${r.startError ?? 'session not found'}. Run \`work tree ${parent.target} ${branch}\`.`));
      process.exitCode = 1;
      return;
    }
    if (!attach) {
      console.log(chalk.gray(`Running in the PTY host: \`work attach ${parent.target} ${branch}\` to see it.`));
      return;
    }
    process.exitCode = await attachSession(fork, { initialPrompt: firstPrompt ?? undefined, forwardEnv: true });
  },
};
