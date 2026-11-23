import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { findSession, findSessionById, loadHistory, type WorktreeSession } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { childrenOf, coordinatorMessage, coordinatorSince, driveCheck, GRANT_HINT, parentOf } from '../core/sessions/session-children.js';
import { sendHowText } from '../core/sessions/session-control.js';
import { readStatus } from '../core/status/session-status.js';
import type { SendWire } from '../core/api-types.js';

/**
 * `work child` — a coordinating session's own sessions (session-children.ts): `spawn` one on a new branch with its
 * task, `list` them, `send` one a follow-up, `finish` one (archive it: its agent stopped, its work kept). Run from the
 * coordinator's folder; it acts only on the sessions that one started, and only once `work coordinate --on` granted
 * it — so work's session settings can allow `work child` without asking each time.
 */

const ACTIONS = ['spawn', 'list', 'send', 'finish'] as const;
type Action = (typeof ACTIONS)[number];

const label = (s: WorktreeSession) => `${s.target} · ${s.branch}`;

function fail(message: string): void {
  console.error(chalk.red(message));
  process.exitCode = 1;
}

// No --file: `work child` runs without asking, and a file read for it would skip the repo's deny rules (no Read call).
function text(argv: Record<string, unknown>): string | null {
  return typeof argv.message === 'string' ? argv.message : null;
}

export const childCommand: CommandModule = {
  command: 'child <action> [target] [branch]',
  describe: "A coordinating session's own sessions: spawn, list, send, finish (run from the coordinator's folder)",
  builder: (yargs) =>
    yargs
      .positional('action', { choices: ACTIONS, describe: 'spawn | list | send | finish' })
      .positional('target', { type: 'string', describe: 'Repo alias or group of the child' })
      .positional('branch', { type: 'string', describe: "The child's branch (spawn: a new one)" })
      .option('message', { alias: 'm', type: 'string', describe: 'spawn: its task; send: the message' })
      .option('base', { type: 'string', describe: 'spawn: the branch to start from (default: the repo’s base)' })
      .option('name', { type: 'string', describe: 'spawn: a name for it' })
      .option('account', { type: 'string', describe: 'spawn: the Claude account it runs on' })
      .option('json', { type: 'boolean', default: false, describe: 'Print the result as JSON' }),
  handler: async (argv) => {
    const action = argv.action as Action;
    const sessions = loadHistory();
    const me = findSessionForCwd(process.cwd(), sessions);
    if (!me) return fail("This folder is not inside a work session: run `work child` from the coordinating session's folder.");
    const myId = sessionIdFor(me);
    const json = argv.json === true;

    if (action === 'list') {
      const rows = childrenOf(myId).map((k) => {
        const s = findSessionById(k.id);
        const st = readStatus(k.id);
        return {
          sessionId: k.id,
          target: s?.target ?? null,
          branch: s?.branch ?? null,
          startedAt: k.at,
          archived: !s || !!s.archivedAt,
          state: st?.state ?? null,
          summary: st?.summary ?? null,
        };
      });
      if (json) return void process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      if (!coordinatorSince(myId)) console.error(chalk.gray(`Not coordinating: ${GRANT_HINT}.`));
      if (!rows.length) return void console.log(chalk.gray('No sessions started from this one.'));
      for (const r of rows)
        console.log(
          `${r.target ?? '?'} · ${r.branch ?? '?'}  ${r.archived ? chalk.gray('archived') : (r.state ?? 'not started')}${r.summary && !r.archived ? chalk.gray(`  ${r.summary}`) : ''}`,
        );
      return;
    }

    const target = typeof argv.target === 'string' ? argv.target : undefined;
    const branch = typeof argv.branch === 'string' ? argv.branch : undefined;
    if (!target || !branch) return fail(`work child ${action} needs <target> <branch>.`);

    if (action === 'spawn') {
      const task = text(argv);
      if (!task?.trim()) return fail('Give its task with -m "…".');
      const r = await callWorkWeb<{ sessionId: string; started?: string; startError?: string; warnings?: string[] }>(
        'POST',
        '/api/worktrees',
        {
          target,
          branch,
          prompt: task,
          parentId: myId,
          ...(typeof argv.base === 'string' ? { base: argv.base } : {}),
          ...(typeof argv.name === 'string' ? { name: argv.name } : {}),
          ...(typeof argv.account === 'string' ? { account: argv.account } : {}),
        },
        300_000, // a worktree, its setup and its agent's start
      );
      if (!r.ok) return fail(r.error);
      if (json) return void process.stdout.write(JSON.stringify({ target, branch, ...r.body }, null, 2) + '\n');
      for (const w of r.body.warnings ?? []) console.error(chalk.yellow(w));
      if (r.body.startError) return fail(`${target} · ${branch} was made, but its agent did not start: ${r.body.startError}`);
      console.log(`${target} · ${branch}: started with its task. It reports back with \`work report\`.`);
      return;
    }

    const child = findSession(sessions, target, branch);
    if (!child) return fail(`No session ${target} ${branch}.`);
    const childId = sessionIdFor(child);
    const may = driveCheck(myId, childId, { parentOf, coordinator: (id) => coordinatorSince(id) !== null });
    if (!may.ok) return fail(`${label(child)}: ${may.error}`);

    if (action === 'send') {
      const msg = text(argv);
      if (!msg?.trim()) return fail('Give the message with -m "…".');
      const r = await callWorkWeb<SendWire>('POST', `/api/sessions/${childId}/send`, {
        text: coordinatorMessage(me.title?.trim() || label(me), msg),
      });
      if (!r.ok) return fail(r.error);
      console.log(`${label(child)}: ${sendHowText(r.body.how)}`);
      return;
    }

    // finish: archived as the dashboard's Archive does — its agent stopped, uncommitted work saved, nothing discarded.
    const r = await callWorkWeb<{ ok: true; warnings?: string[] }>('POST', `/api/sessions/${childId}/archive`, { archived: true }, 120_000);
    if (!r.ok) return fail(`${label(child)}: ${r.error}`);
    for (const w of r.body.warnings ?? []) console.error(chalk.yellow(w));
    console.log(`${label(child)}: archived (its branch and work are kept; Restore brings it back).`);
  },
};
