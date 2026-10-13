import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { loadHistory } from '../core/sessions/history.js';
import type { RestartWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work restart` — restart a session's agent in the PTY host (its conversation goes on, its terminals stay attached):
 * after its tool updated, so it runs the new version. One working or waiting on you restarts when its turn ends
 * (POST /api/agents/restart, core/pty/agent-restart.ts).
 */
export const restartCommand: CommandModule = {
  command: 'restart [target] [branch]',
  describe: "Restart a session's agent, resuming its conversation (one at work restarts after its turn)",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('outdated', { type: 'boolean', describe: 'Every agent still running a version from before its tool updated' })
      .option('all', { type: 'boolean', describe: 'Every agent in the PTY host' })
      .conflicts('all', 'outdated'),
  handler: async (argv) => {
    let body: { ids: string[] } | { outdated: true } | { all: true };
    const names = new Map(loadHistory().map((s) => [sessionIdFor(s), `${s.target} · ${s.branch}`]));
    const label = (id: string) => names.get(id) ?? (id === 'assistant' ? 'the assistant (Ctrl+K)' : id);
    if (argv.all) body = { all: true };
    else if (argv.outdated) body = { outdated: true };
    else {
      const s = sessionFromArgs(argv);
      if (!s) return;
      body = { ids: [sessionIdFor(s)] };
    }
    const r = await callWorkWeb<RestartWire>('POST', '/api/agents/restart', body, 60_000);
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    const { now, later, failed } = r.body;
    for (const id of now) console.log(`${label(id)}: restarted`);
    for (const id of later) console.log(`${label(id)}: restarts when its turn ends (it is working or waiting on you)`);
    for (const f of failed) console.error(chalk.red(`${label(f.id)}: couldn't restart: ${f.error}`));
    if (!now.length && !later.length && !failed.length)
      console.log(argv.outdated ? 'Every agent runs its newest version.' : 'Nothing to restart.');
    if (failed.length) process.exitCode = 1;
  },
};
