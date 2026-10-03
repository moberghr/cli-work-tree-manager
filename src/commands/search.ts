import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadHistory } from '../core/sessions/history.js';
import { searchConversations, syncConversations } from '../core/conversations/conversation-store.js';

export const searchCommand: CommandModule = {
  command: 'search <query..>',
  describe: "Search every session's conversation, live and archived (work keeps them past Claude Code's 30 days); --json",
  builder: (yargs) =>
    yargs
      .positional('query', { type: 'string', array: true, describe: 'Words that must all appear in one message' })
      .option('json', { type: 'boolean', default: false, describe: 'As JSON: the /api/conversations/search hits' }),
  handler: async (argv) => {
    const query = ((argv.query as string[] | undefined) ?? []).join(' ').trim();
    const history = loadHistory();
    // Up to the minute: copy what the live sessions wrote since the last sync.
    await syncConversations(history.filter((s) => !s.archivedAt)).catch(() => undefined);
    const hits = await searchConversations(query, { sessions: history });
    if (argv.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
      return;
    }
    if (hits.length === 0) {
      console.log(chalk.gray(`No conversation mentions "${query}".`));
      return;
    }
    for (const h of hits) {
      const when = h.archived ? `archived ${h.archivedAt?.slice(0, 10) ?? ''}` : (h.lastAt?.slice(0, 10) ?? '');
      console.log(chalk.bold(`${h.target} · ${h.branch}`) + chalk.gray(`  ${when}  ${h.sessionId}`));
      for (const sn of h.snippets) {
        const who = sn.role === 'you' ? 'You' : sn.role === 'summary' ? 'Summary' : 'Claude';
        console.log(`  ${chalk.cyan(who + ':')} ${sn.text}`);
      }
    }
  },
};
