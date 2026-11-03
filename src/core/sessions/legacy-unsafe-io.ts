import { dbPtySessions } from '../pty/pty-sessions-file.js';
import { liveAgents } from '../agents/index.js';
import { agentsBySession } from './live-agents.js';
import { loadHistory } from './history.js';
import { startedUnsafeBefore } from './legacy-unsafe.js';
import type { WorktreeSession } from './session-types.js';

// REMOVE IN THE NEXT RELEASE with legacy-unsafe.ts: its rule, read from state.db and the running agents.

/**
 * `startedUnsafeBefore` for a session, read from state.db and the running agents. `hostPids`: the PTY host's agents (work web's pool knows
 * them); without them, every live agent of the session counts as outside — with no restore entry, the host runs none.
 */
export function runsUnsafeFromBefore(
  id: string,
  session: WorktreeSession | null | undefined,
  hostPids: ReadonlySet<number> = new Set(),
): boolean {
  return startedUnsafeBefore(session, dbPtySessions.read()[id], () =>
    (agentsBySession(liveAgents(), loadHistory()).get(id) ?? []).some((c) => !hostPids.has(c.pid)),
  );
}
