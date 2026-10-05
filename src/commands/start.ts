import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import type { AgentControlWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work start` — start a session's agent in the PTY host, resuming its conversation (work web's POST …/agent/start). */
export const startCommand: CommandModule = {
  command: 'start [target] [branch]',
  describe: "Start a session's agent in the background, resuming its conversation (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs).option('force', {
      type: 'boolean',
      default: false,
      describe: 'Start one even though it runs in a terminal outside work (two would share one conversation)',
    }),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const r = await callWorkWeb<AgentControlWire>(
      'POST',
      `/api/sessions/${sessionIdFor(s)}/agent/start`,
      { force: argv.force === true },
      60_000,
    );
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(
      r.body.how === 'running'
        ? `${s.target} · ${s.branch}: already running`
        : `${s.target} · ${s.branch}: started (\`work attach\` to watch it)`,
    );
  },
};
