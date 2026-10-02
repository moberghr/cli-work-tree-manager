import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/web-discovery.js';
import { sessionIdFor } from '../core/session-id.js';
import { agentFor } from '../core/agents/index.js';
import { loadConfig } from '../core/config.js';
import { parseDuration, sendHowText, waitForTurn } from '../core/session-control.js';
import type { SendWire } from '../core/api-types.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';
import { formatConversation, READ_AS_DATA } from './shared/conversation-format.js';
import { cliWaitDeps } from './shared/turn-wait.js';

/**
 * `work send` — a message to a session's agent, now: typed into its terminal
 * when it's idle in the PTY host, started for it when it isn't running, on its
 * next turn otherwise (work web's POST …/send, session-control.ts). With
 * --wait, waits for that turn to end and prints what it said.
 */
export const sendCommand: CommandModule = {
  command: 'send [target] [branch]',
  describe: "Send a session's agent a message now (default: the session for this folder); --wait for its answer",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('message', { alias: 'm', type: 'string', describe: 'The message' })
      .option('file', { type: 'string', describe: 'Read the message from a file' })
      .option('wait', { type: 'boolean', default: false, describe: 'Wait for the turn it starts to end, then print the reply' })
      .option('timeout', { type: 'string', default: '15m', describe: 'With --wait: give up after this long (90s, 15m, 1h)' })
      .option('force', { type: 'boolean', default: false, describe: 'Send to a session running with permission checks off (--unsafe)' })
      .check((a) => (typeof a.message === 'string') !== (typeof a.file === 'string') || 'Give the message with -m "…" or --file <path> (one of them)'),
  handler: async (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const text = typeof argv.file === 'string' ? fs.readFileSync(argv.file, 'utf8') : String(argv.message);
    const timeoutMs = parseDuration(String(argv.timeout));
    if (argv.wait && timeoutMs === null) {
      console.error(chalk.red(`--timeout: not a duration: ${String(argv.timeout)} (try 90s, 15m, 1h)`));
      process.exitCode = 1;
      return;
    }
    const id = sessionIdFor(s);
    const r = await callWorkWeb<SendWire>('POST', `/api/sessions/${id}/send`, { text, force: argv.force === true });
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.error(chalk.gray(`${s.target} · ${s.branch}: ${sendHowText(r.body.how)}`));
    if (!argv.wait) return;

    console.error(chalk.gray('Waiting for its turn to end…'));
    const done = await waitForTurn(id, cliWaitDeps, { after: r.body.sentAt, timeoutMs: timeoutMs! });
    if (!done.ok) {
      console.error(chalk.yellow(`No answer within ${String(argv.timeout)} (it is ${done.status?.state ?? 'not reporting'}). \`work wait\` or \`work read\` later.`));
      process.exitCode = 2;
      return;
    }
    const agent = agentFor(loadConfig());
    const reply = (agent.conversation?.read(s, { last: 60 }) ?? []).filter((e) => e.at > r.body.sentAt);
    console.error(chalk.gray(`${done.status.state === 'needs_input' ? 'It is waiting for you' : 'Its turn ended'} — ${READ_AS_DATA}`));
    if (reply.length) console.log(formatConversation(reply, agent.name));
    else if (done.status.summary) console.log(done.status.summary);
  },
};
