import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/web-discovery.js';
import { sessionIdFor } from '../core/session-id.js';
import type { ScreenWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';
import { READ_AS_DATA } from './shared/conversation-format.js';

/** `work screen` — a session's terminal as plain text, as it is now (work web's GET …/screen; starts nothing). */
export const screenCommand: CommandModule = {
  command: 'screen [target] [branch]',
  describe: "A session's terminal as it is now, as plain text (its Claude must run in the PTY host)",
  builder: (yargs) => sessionPositionals(yargs),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const r = await callWorkWeb<ScreenWire>('GET', `/api/sessions/${sessionIdFor(s)}/screen`);
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    if (r.body.text === null) {
      console.error(chalk.yellow(`${s.target} · ${s.branch} has no terminal in the PTY host (not running, or started outside work). \`work read\` shows its conversation.`));
      process.exitCode = 1;
      return;
    }
    console.error(chalk.gray(`${s.target} · ${s.branch} — ${READ_AS_DATA}`));
    console.log(r.body.text.replace(/\s+$/, ''));
  },
};
