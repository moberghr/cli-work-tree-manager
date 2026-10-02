import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/web-discovery.js';
import { sessionIdFor } from '../core/session-id.js';
import { readStatus } from '../core/session-status.js';
import { pendingRequest } from '../core/session-control.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work answer` — the permission prompt a session's agent is waiting on:
 * shows it, and with --allow / --deny answers it (the inbox's Allow / Deny:
 * POST …/answer, which first checks the dialog on its screen is that very
 * request). Never put this on an allow list: approving another agent's tool
 * call is yours to say, so Claude Code should ask you every time.
 */
export const answerCommand: CommandModule = {
  command: 'answer [target] [branch]',
  describe: "Show the permission prompt a session's agent waits on; --allow or --deny answers it",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('allow', { type: 'boolean', default: false, describe: 'Approve the tool call it asks about' })
      .option('deny', { type: 'boolean', default: false, describe: 'Refuse it (the agent stops and waits for you)' })
      .check((a) => !(a.allow && a.deny) || 'Either --allow or --deny, not both'),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const request = pendingRequest(readStatus(id));
    if (!request) {
      console.error(chalk.yellow(`${s.target} · ${s.branch} isn't waiting on a permission prompt.`));
      process.exitCode = 1;
      return;
    }
    const what = `${request.tool}: ${request.detail}`;
    if (!argv.allow && !argv.deny) {
      console.log(what);
      console.error(chalk.gray('Answer with --allow or --deny.'));
      return;
    }
    // The request it was shown goes along: the route refuses if the prompt changed meanwhile.
    const r = await callWorkWeb<{ ok: true }>('POST', `/api/sessions/${id}/answer`, { answer: argv.allow ? 'allow' : 'deny', request });
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(`${argv.allow ? 'Allowed' : 'Denied'}: ${what}`);
  },
};
