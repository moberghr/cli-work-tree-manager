import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { listReplies, postDrafts, saveDraft } from '../core/pr/pr-replies.js';
import { defaultRunner } from '../core/pr/ship.js';
import { readWebUrl } from '../core/platform/web-discovery.js';

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
 * thread). The dashboard shows the draft to you, editable.
 * `work pr post <thread…> [--all] [--resolve]` — posts the drafts as they
 * stand, which Claude runs only after you said yes to them.
 * `work pr replies [--json]` lists the threads and drafts.
 */
export const prCommand: CommandModule = {
  command: 'pr <action>',
  describe: 'Review threads handed to this session: draft replies, and post them once the user says yes',
  builder: (y) =>
    y
      .command(
        'reply <thread> [text..]',
        "Draft the reply to a review thread (shown in the dashboard; posted only on the user's yes)",
        (b) =>
          b
            .positional('thread', { type: 'string', demandOption: true, describe: 'The thread id from the feedback note (PRRT_…)' })
            .positional('text', { type: 'string', array: true, describe: 'The reply' })
            .option('body-file', { type: 'string', describe: 'Read the reply from this file instead' }),
        async (argv) => {
          const s = sessionHere();
          const text = argv['body-file']
            ? fs.readFileSync(String(argv['body-file']), 'utf8')
            : ((argv.text as string[] | undefined) ?? []).join(' ');
          const id = sessionIdFor(s);
          const r = saveDraft(id, String(argv.thread), text);
          if (!r.ok) {
            console.error(chalk.red(r.error));
            process.exit(1);
          }
          await nudgeWeb(id);
          console.log(
            `Draft saved for ${r.reply.reviewer}'s thread on PR #${r.reply.prNumber}. Show it to the user; post it (work pr post ${r.reply.threadId}) only once they say yes.`,
          );
        },
      )
      .command(
        'post [threads..]',
        'Post drafted replies from your GitHub account — for Claude, only once the user has said yes to them',
        (b) =>
          b
            .positional('threads', { type: 'string', array: true, describe: 'Thread ids (PRRT_…) whose drafts to post' })
            .option('all', { type: 'boolean', default: false, describe: 'Every draft of this session' })
            .option('resolve', { type: 'boolean', default: false, describe: 'Also resolve each thread (for comments you fixed)' }),
        async (argv) => {
          const s = sessionHere();
          const id = sessionIdFor(s);
          const asked = (argv.threads as string[] | undefined) ?? [];
          const drafts = listReplies(id).filter((r) => r.status === 'draft' && (argv.all || asked.includes(r.threadId)));
          const unknown = argv.all ? [] : asked.filter((t) => !drafts.some((r) => r.threadId === t));
          for (const t of unknown)
            console.error(chalk.red(`${t}: no draft to post for this session (draft it with \`work pr reply\` first)`));
          if (drafts.length === 0) {
            if (!unknown.length) console.error(chalk.red('Nothing to post: name the threads, or --all.'));
            process.exit(1);
          }
          const r = await postDrafts(s, drafts, argv.resolve === true, defaultRunner);
          await nudgeWeb(id);
          for (const p of r.posted)
            console.log(`Posted to @${p.reviewer}'s thread on PR #${p.prNumber}${p.resolved ? ' (resolved)' : ''}: ${p.url}`);
          for (const f of r.failed) console.error(chalk.red(`${f.threadId}: ${f.error}`));
          if (r.failed.length || unknown.length) process.exit(1);
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
