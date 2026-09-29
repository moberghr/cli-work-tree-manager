import fs from 'node:fs';
import path from 'node:path';
import { sessionIdFor } from './session-id.js';
import { statusFileFor } from './session-status.js';
import { commentsDir, commentsFileFor } from './comment-file-store.js';
import { forgetPersistedSession } from './pty-sessions-file.js';
import { logSwallowed } from './best-effort.js';
import { devLogFile, stopDev } from './dev-server.js';
import { prWatchFileFor } from './pr-watch-store.js';

/**
 * Owner of a session's state beyond its history.json entry. Everything
 * per-session is keyed by sessionIdFor(target, branch):
 *
 *   ~/.work/status/<id>.json               attention status (hooks)
 *   ~/.work/comments/<id>.json             review comments
 *   ~/.work/comments/<id>.delivered.json   which comments reached Claude
 *   ~/.work/pty-sessions.json [<id>]       restore-after-reboot entry
 *   ~/.work/dev/<id>.json|.log             dev server pid + output (stopped first)
 *   ~/.work/pr-watch/<id>.json             PR watch: comments / CI failures acted on
 *
 * (Diff scopes and their checkpoint refs are keyed by scope hash, not by
 * session, and are swept by work web.)
 *
 * § WHEN adding per-session state, add its path here, so removing a session
 * removes it — before this module, deleted sessions left their status and
 * comment files behind, and a re-created session with the same
 * target:branch inherited them.
 */

export function sessionStatePaths(id: string): string[] {
  return [statusFileFor(id), commentsFileFor(id), path.join(commentsDir(), `${id}.delivered.json`), devLogFile(id), prWatchFileFor(id)];
}

/** Remove every per-session file for a session that no longer exists.
 *  Best-effort per file (logged), never throws. */
export async function purgeSessionState(target: string, branch: string): Promise<void> {
  const id = sessionIdFor({ target, branch });
  try {
    stopDev(id); // also removes its pid file
  } catch (err) {
    logSwallowed(`stop dev server ${id}`, err);
  }
  for (const p of sessionStatePaths(id)) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      logSwallowed(`purge ${p}`, err);
    }
  }
  await forgetPersistedSession(id).catch((err) => logSwallowed(`forget saved PTY session ${id}`, err));
}
