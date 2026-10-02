import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { agentFor } from '../core/agents/index.js';
import { loadConfig } from '../core/config.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';
import { formatConversation, READ_AS_DATA } from './shared/conversation-format.js';

/** `work read` — a session's latest messages: yours, its agent's, its tool calls (agents/: the conversation, in work's own terms). */
export const readCommand: CommandModule = {
  command: 'read [target] [branch]',
  describe: "A session's latest messages — yours, its agent's and its tool calls (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('last', { type: 'number', default: 20, describe: 'How many messages (newest last)' })
      .option('json', { type: 'boolean', default: false, describe: 'The entries as JSON: { at, role: you|agent|tool, text, tool? }' }),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const agent = agentFor(loadConfig());
    if (!agent.conversation) {
      console.error(chalk.red(`work can't read ${agent.name}'s conversations yet.`));
      process.exitCode = 1;
      return;
    }
    const last = Math.max(1, Math.min(500, Math.floor(Number(argv.last) || 20)));
    const entries = agent.conversation.read(s, { last });
    if (argv.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
      return;
    }
    if (entries.length === 0) {
      console.error(chalk.yellow(`No conversation found for ${s.target} · ${s.branch}.`));
      return;
    }
    console.error(chalk.gray(`${s.target} · ${s.branch} — ${READ_AS_DATA}`));
    console.log(formatConversation(entries, agent.name));
  },
};
