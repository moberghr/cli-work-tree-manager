import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import type { AddRepoWire } from '../core/api-types.js';
import { agentFor } from '../core/agents/index.js';
import { getCommentFileStore } from '../core/comments/comment-file-store.js';
import { loadConfig } from '../core/platform/config.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { findSessionById } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import type { WorktreeSession } from '../core/sessions/session-types.js';
import { addedRepoNote, addRepoToSession, AddRepoRefused, type AddRepoResult } from '../core/worktree/add-repo.js';
import { sessionFromArgs } from './shared/session-arg.js';

/**
 * `work add-repo <alias>` — check a repo out into a session folder on the
 * session's branch (add-repo.ts). Through a running work web (which runs it
 * off its event loop and tells the session's Claude); with none, here, the
 * note to Claude left in its comments for its next turn.
 */

const SETTLE_MS = 10 * 60_000;

function printDone(s: WorktreeSession, r: Pick<AddRepoWire, 'path' | 'branch' | 'created' | 'from' | 'warnings'>, alias: string): void {
  const how = r.created ? `a new branch ${r.branch}${r.from ? ` from ${r.from}` : ''}` : `its branch ${r.branch}`;
  console.log(chalk.green(`Added ${alias} to ${s.target} · ${s.branch}: ${r.path} (${how})`));
  for (const w of r.warnings ?? []) console.log(chalk.yellow(`  ${w}`));
}

/** The result as the wire carries it (the route's answer, and `--json`). */
export function addRepoWireOf(r: AddRepoResult): AddRepoWire {
  return {
    ok: true,
    path: r.path,
    branch: r.branch,
    created: r.created,
    ...(r.from ? { from: r.from } : {}),
    imported: r.imported,
    warnings: r.warnings,
  };
}

export const addRepoCommand: CommandModule = {
  command: 'add-repo <alias> [target] [branch]',
  describe:
    "Add a repo to a session folder: checked out there on the session's branch, its Claude told (default: the session for this folder)",
  builder: (yargs) =>
    yargs
      .positional('alias', { type: 'string', describe: 'The repo to add (an alias from your config)', demandOption: true })
      .positional('target', { type: 'string', describe: 'Repo alias or group (default: the session for this folder)' })
      .positional('branch', { type: 'string', describe: 'Its branch' })
      .option('base', {
        type: 'string',
        describe: "Branch to make the session's branch from when the repo hasn't got it (default: its checkout's)",
      })
      .option('session-id', { type: 'string', hidden: true, describe: 'The session, by id (work web)' })
      .option('in-process', { type: 'boolean', hidden: true, default: false, describe: 'Run it here, without telling Claude (work web)' })
      .option('json', { type: 'boolean', hidden: true, default: false, describe: 'The outcome as JSON on stdout' }),
  handler: async (argv) => {
    const alias = String(argv.alias);
    const base = typeof argv.base === 'string' && argv.base.trim() ? argv.base.trim() : undefined;
    const asJson = argv.json === true;
    const fail = (error: string, status?: number) => {
      if (asJson) console.log(JSON.stringify({ error, ...(status ? { status } : {}) }));
      else console.error(chalk.red(error));
      process.exitCode = 1;
    };
    const failWith = (err: unknown) => fail((err as Error).message, err instanceof AddRepoRefused ? err.status : 500);

    const byId = typeof argv['session-id'] === 'string' ? argv['session-id'] : undefined;
    const s = byId ? findSessionById(byId) : sessionFromArgs(argv);
    if (!s) return byId ? fail('unknown session', 404) : undefined;
    const id = sessionIdFor(s);

    // work web's child: the add alone; the route tells Claude and the dashboard.
    if (argv['in-process'] === true) {
      let r: AddRepoResult;
      try {
        r = await addRepoToSession(id, alias, { base });
      } catch (err) {
        return failWith(err);
      }
      if (asJson) console.log(JSON.stringify(addRepoWireOf(r)));
      else printDone(s, addRepoWireOf(r), alias);
      return;
    }

    const viaWeb = await callWorkWeb<AddRepoWire>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/repos`,
      { alias, ...(base ? { base } : {}) },
      SETTLE_MS,
    );
    if (viaWeb.ok) {
      if (asJson) console.log(JSON.stringify(viaWeb.body));
      else printDone(s, viaWeb.body, alias);
      return;
    }
    if (viaWeb.status !== 0) return fail(viaWeb.error, viaWeb.status > 0 ? viaWeb.status : undefined);

    // No work web: here, and the note waits in its comments for its next turn.
    let r: AddRepoResult;
    try {
      r = await addRepoToSession(id, alias, { base });
    } catch (err) {
      return failWith(err);
    }
    // The repo is in: a note that can't be left is said, never reported as the add failing.
    let told = true;
    try {
      const after = findSessionById(id) ?? s;
      const file = agentFor(loadConfig() ?? {}, after).instructionsFile;
      getCommentFileStore(id).post({ side: 'general', status: 'published', author: 'user', body: addedRepoNote(r, file) });
    } catch (err) {
      told = false;
      r.warnings.push(`couldn't leave the note for its Claude: ${(err as Error).message}`);
    }
    if (asJson) console.log(JSON.stringify(addRepoWireOf(r)));
    else {
      printDone(s, addRepoWireOf(r), alias);
      if (told) console.log(chalk.gray("Its Claude is told on its next turn (work web isn't running)."));
    }
  },
};
