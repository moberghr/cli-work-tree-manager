import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import type { AgentControlWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work stop` — stop a session's agent in the PTY host; its conversation is kept, and opening the session resumes it (POST …/agent/stop). */
export const stopCommand: CommandModule = {
  command: 'stop [target] [branch]',
  describe: "Stop a session's agent (its conversation is kept; opening the session resumes it)",
  builder: (yargs) => sessionPositionals(yargs),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const r = await callWorkWeb<AgentControlWire>('POST', `/api/sessions/${sessionIdFor(s)}/agent/stop`, {});
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(r.body.how === 'not-running' ? `${s.target} · ${s.branch}: not running` : `${s.target} · ${s.branch}: stopped`);
  },
};
