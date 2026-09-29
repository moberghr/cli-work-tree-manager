import fs from 'node:fs';
import { sessionIdFor } from './session-id.js';
import { purgeSessionRows, tx } from './db.js';
import { logSwallowed } from './best-effort.js';
import { devLogFile, stopDev } from './dev-server.js';

/**
 * Owner of a session's state beyond its `sessions` row. Everything
 * per-session is keyed by sessionIdFor(target, branch) and lives in
 * state.db (db.ts):
 *
 *   session_status       attention status (hooks)
 *   comments [store=id]  review comments
 *   comment_deliveries   which comments reached Claude
 *   pty_sessions         restore-after-reboot entry
 *   pr_watch_seen        PR watch: comments / CI failures acted on
 *   dev_runs             dev server pid (the server is stopped first)
 *
 * plus one file, ~/.work/dev/<id>.log (the dev server's output).
 *
 * (Diff scopes and their checkpoint refs are keyed by scope hash, not by
 * session, and are swept by work web.)
 *
 * § WHEN adding per-session state, add its table to `purgeSessionRows`
 * (db.ts), or its file here — so removing a session removes it. Before
 * this, deleted sessions left their state behind and a re-created session
 * with the same target:branch inherited it.
 */

/** Per-session files that live outside the database. */
export function sessionStatePaths(id: string): string[] {
  return [devLogFile(id)];
}

/** Before the session's rows go: stop its dev server (needs the dev_runs
 *  row). Best-effort, logged. */
export function stopSessionDevServer(id: string): void {
  try {
    stopDev(id);
  } catch (err) {
    logSwallowed(`stop dev server ${id}`, err);
  }
}

/** After the session's rows are gone: its files. Best-effort per file. */
export function removeSessionFiles(id: string): void {
  for (const p of sessionStatePaths(id)) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      logSwallowed(`purge ${p}`, err);
    }
  }
}

/**
 * Remove every piece of per-session state for a session that has no
 * `sessions` row (any more). history.ts removes a session's row and its
 * state in ONE transaction (`purgeSessionRows`); this is the standalone
 * form for state left behind. Best-effort per step (logged), never throws.
 */
export async function purgeSessionState(target: string, branch: string): Promise<void> {
  const id = sessionIdFor({ target, branch });
  stopSessionDevServer(id);
  try {
    tx((d) => purgeSessionRows(d, id));
  } catch (err) {
    logSwallowed(`purge state rows ${id}`, err);
  }
  removeSessionFiles(id);
}
