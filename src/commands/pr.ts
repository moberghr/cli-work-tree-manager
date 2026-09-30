import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { findSessionForCwd } from '../core/pending-delivery.js';
import { sessionIdFor } from '../core/session-id.js';
import { listReplies, saveDraft } from '../core/pr-replies.js';
import { readWebUrl } from '../core/web-discovery.js';

/** Tell a running work web a draft changed, so the session header shows it. Best effort. */
async function nudgeWeb(sessionId: string): Promise<void> {
  const base = readWebUrl();
  if (!base) return;
  await fetch(`${base}api/replies-changed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

function sessionHere() {
  const s = findSessionForCwd(process.cwd());
  if (!s) {
    console.error(chalk.red('Not inside a work session (run this from the worktree).'));
    process.exit(1);
  }
  return s;
}

/**
 * `work pr reply <thread> "<text>"` — for the session's Claude: draft the
 * answer to a review thread it was handed (the PR feedback note names each
 * thread). Only a draft: the dashboard shows it to you, and you post it.
 * `work pr replies [--json]` lists the threads and drafts.
 */
export const prCommand: CommandModule = {
  command: 'pr <action>',
  describe: 'Review threads handed to this session: draft replies for you to post',
  builder: (y) =>
    y
      .command(
        'reply <thread> [text..]',
        'Draft the reply to a review thread (you review and post it in the dashboard)',
        (b) =>
          b
            .positional('thread', { type: 'string', demandOption: true, describe: 'The thread id from the feedback note (PRRT_…)' })
            .positional('text', { type: 'string', array: true, describe: 'The reply' })
            .option('body-file', { type: 'string', describe: 'Read the reply from this file instead' }),
        async (argv) => {
          const s = sessionHere();
          const text = argv['body-file'] ? fs.readFileSync(String(argv['body-file']), 'utf8') : ((argv.text as string[] | undefined) ?? []).join(' ');
          const id = sessionIdFor(s);
          const r = saveDraft(id, String(argv.thread), text);
          if (!r.ok) {
            console.error(chalk.red(r.error));
            process.exit(1);
          }
          await nudgeWeb(id);
          console.log(`Draft saved for ${r.reply.reviewer}'s thread on PR #${r.reply.prNumber}. It is posted only when the user approves it in the dashboard.`);
        },
      )
      .command(
        'replies',
        'List the review threads handed to this session and their drafts',
        (b) => b.option('json', { type: 'boolean', default: false }),
        (argv) => {
          const list = listReplies(sessionIdFor(sessionHere()));
          if (argv.json) {
            process.stdout.write(JSON.stringify(list, null, 2) + '\n');
            return;
          }
          if (list.length === 0) console.log(chalk.gray('No review threads handed to this session.'));
          for (const r of list) {
            console.log(`${r.threadId}  PR #${r.prNumber} ${r.where ?? ''}  @${r.reviewer}  ${chalk.gray(r.status)}`);
            if (r.draft) console.log(chalk.gray(`  ${r.draft.replace(/\s+/g, ' ').slice(0, 160)}`));
          }
        },
      )
      .demandCommand(1),
  handler: () => {},
};
