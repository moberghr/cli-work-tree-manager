import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import type { AgentControlWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work start` — start a session's agent in the PTY host, resuming its conversation (work web's POST …/agent/start).
 * An archived session is restored first (asked for: an agent told "restore it first" tried commands until `work tree`
 * worked): work web's Restore (POST …/archive {archived: false}) — the worktree, its uncommitted work and the
 * conversation as they were — then started, in the background as ever.
 */
export const startCommand: CommandModule = {
  command: 'start [target] [branch]',
  describe:
    "Start a session's agent in the background, resuming its conversation; an archived one is restored first (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs).option('force', {
      type: 'boolean',
      default: false,
      describe: 'Start one even though it runs in a terminal outside work (two would share one conversation)',
    }),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const fail = (message: string) => {
      console.error(chalk.red(message));
      process.exitCode = 1;
    };
    let restored = false;
    if (s.archivedAt) {
      console.log(chalk.gray(`${s.target} · ${s.branch} is archived: restoring it…`));
      // Making its worktree again can take a while (a big repo, its setup).
      const back = await callWorkWeb<{ ok?: boolean; warnings?: string[] }>(
        'POST',
        `/api/sessions/${id}/archive`,
        { archived: false },
        300_000,
      );
      if (!back.ok) return fail(`Couldn't restore it: ${back.error}`);
      for (const w of back.body.warnings ?? []) console.log(chalk.yellow(w));
      restored = true;
    }
    const r = await callWorkWeb<AgentControlWire>('POST', `/api/sessions/${id}/agent/start`, { force: argv.force === true }, 60_000);
    if (!r.ok) return fail(restored ? `Restored it, but couldn't start its agent: ${r.error}` : r.error);
    console.log(
      r.body.how === 'running'
        ? `${s.target} · ${s.branch}: already running`
        : `${s.target} · ${s.branch}: ${restored ? 'restored and started' : 'started'} (\`work attach\` to watch it)`,
    );
  },
};
