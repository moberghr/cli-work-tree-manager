import type { SessionHistoryWire } from '../api-types.js';
import { bestEffortAsync } from '../platform/best-effort.js';
import { workingBranch } from '../git/git-head.js';
import { readSessionBranches } from '../sessions/session-branches.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { loadManifest } from './checkpoint.js';
import { scopeHashForPaths } from './scope-manager.js';
import { historyBranchRefs, sessionHistory, type SessionHistory } from './session-history.js';

/**
 * `GET /api/sessions/:id/checkpoints`: the Diff tab's history. Its turns (the scope's manifest, read from disk by the
 * hash of its paths — a GET creates nothing), the commits since the branch's base, and every other branch it worked
 * on (session-branches.ts), merged ones too, with each one's whole span (`branchSpans`). Git runs off the event loop,
 * and none at all while nothing moved (sessionHistory's cache). A history that can't be read is empty, never a 500.
 */
export async function sessionHistoryWire(session: WorktreeSession): Promise<SessionHistoryWire> {
  const hash = scopeHashForPaths(session.paths);
  const none: SessionHistory = { commits: [], spans: [] };
  const { commits, spans } =
    (await bestEffortAsync<SessionHistory>(
      'list the session commits',
      () => sessionHistory(session, historyBranchRefs(session, readSessionBranches(sessionIdFor(session)), workingBranch)),
      none,
    )) ?? none;
  return { scopeHash: hash, entries: loadManifest(hash).entries, commits, branchSpans: spans };
}
