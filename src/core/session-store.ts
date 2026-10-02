import fs from 'node:fs';
import { archiveDirFor } from './session-archive.js';
import { conversationDirFor } from './conversation-store.js';
import { sessionIdFor } from './session-id.js';
import { purgeSessionRows, tx } from './db.js';
import { logSwallowed } from './best-effort.js';
import { devLogFile, stopDev } from './dev-server.js';
import { clearCheckpoints } from './checkpoint.js';
import { dropSessionSaves } from './archive-uncommitted.js';
import { scopeHashForPaths } from './scope-manager.js';
import { loadConfig } from './config.js';
import type { WorktreeSession } from './session-types.js';

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
 * plus its diff scope's checkpoints: refs/wd/<hash>/* in its repos and the
 * manifest, keyed by the hash of its paths (clearSessionCheckpoints) — the
 * refs keep their commits (untracked files `add -A` captured included) from
 * git's garbage collection.
 *
 * § WHEN adding per-session state, add its table to `purgeSessionRows`
 * (db.ts), or its file here — so removing a session removes it. Before
 * this, deleted sessions left their state behind and a re-created session
 * with the same target:branch inherited it.
 */

/** Per-session files that live outside the database. */
export function sessionStatePaths(id: string): string[] {
  // Its archive (kept conversation + summary) and work's copy of its
  // conversations go when the session is deleted for good; archiving keeps
  // the session, so they stay then.
  return [devLogFile(id), archiveDirFor(id), conversationDirFor(id)];
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

/**
 * A removed session's checkpoints: the refs in its repos' shared git dir
 * (from the base checkouts: the worktree may already be gone) and the
 * manifest. Best-effort, logged.
 */
export function clearSessionCheckpoints(s: Pick<WorktreeSession, 'target' | 'isGroup' | 'paths'> & { branch?: string }): void {
  try {
    const cfg = loadConfig();
    const aliases = s.isGroup ? (cfg?.groups[s.target] ?? []) : [s.target];
    const roots = aliases.map((a) => cfg?.repos[a]).filter((r): r is string => !!r && fs.existsSync(r));
    clearCheckpoints(scopeHashForPaths(s.paths), roots);
    // Uncommitted work an archive saved (archive-uncommitted.ts): its refs go like the checkpoints'.
    if (s.branch !== undefined) for (const r of roots) dropSessionSaves(r, sessionIdFor({ target: s.target, branch: s.branch }));
  } catch (err) {
    logSwallowed(`clear checkpoints of ${s.target}`, err);
  }
}

/** After the session's rows are gone: its files. Best-effort per file. */
export function removeSessionFiles(id: string): void {
  for (const p of sessionStatePaths(id)) {
    try {
      fs.rmSync(p, { force: true, recursive: true });
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
