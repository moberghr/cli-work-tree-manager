import { dbPtySessions } from '../pty/pty-sessions-file.js';
import { liveAgents } from '../agents/index.js';
import type { LiveAgent } from '../agents/types.js';
import { agentsBySession } from './live-agents.js';
import { clearLaunchedUnsafe, findSession as findRow, loadHistory } from './history.js';
import { findSession } from './web-state.js';
import { sessionIdFor } from './session-id.js';
import { legacyUnsafeCase, type LegacyUnsafe } from './legacy-unsafe.js';
import type { WorktreeSession } from './session-types.js';

// REMOVE IN THE NEXT RELEASE with legacy-unsafe.ts: its rule, read from state.db and the running agents.

/** Where the rule reads from (injectable for tests). */
export interface LegacyUnsafeIo {
  /** The host's restore entry for the session (state.db `pty_sessions`). */
  entry?: (id: string) => unknown;
  /** Every running agent. */
  live?: () => LiveAgent[];
  /** The sessions their folders are matched against. */
  sessions?: () => WorktreeSession[];
}

function agentsOf(id: string, io: LegacyUnsafeIo): LiveAgent[] {
  return agentsBySession((io.live ?? liveAgents)(), (io.sessions ?? loadHistory)()).get(id) ?? [];
}

/**
 * `legacyUnsafeCase` for a session, read from state.db and the running agents. `hostPids`: the PTY host's agents (work
 * web's pool knows them); without them, every live agent of the session counts as outside.
 */
export function runsUnsafeFromBefore(
  id: string,
  session: WorktreeSession | null | undefined,
  hostPids: ReadonlySet<number> = new Set(),
  io: LegacyUnsafeIo = {},
): LegacyUnsafe | null {
  const entry = io.entry ? io.entry(id) : dbPtySessions.read()[id];
  return legacyUnsafeCase(session, entry, () => agentsOf(id, io).some((c) => !hostPids.has(c.pid)));
}

/** work web's check (the PR watch, `work send`): the session by id, the host's pids as its pool knows them now. */
export function legacyUnsafeCheck(
  hostPids: () => ReadonlySet<number>,
  io: LegacyUnsafeIo & { session?: (id: string) => WorktreeSession | null } = {},
): (id: string) => LegacyUnsafe | null {
  return (id) => runsUnsafeFromBefore(id, (io.session ?? findSession)(id), hostPids(), io);
}

/**
 * A current `work` is about to launch the session's agent directly, in its own permission mode: its row's
 * `launchedUnsafe` no longer describes it — unless an agent of the session still runs anywhere (the one launched
 * `--unsafe` before, in another terminal), in which case the flag stays and the guards with it. Returns whether it
 * was cleared (or there was nothing to clear).
 */
export function clearLaunchedUnsafeWhenIdle(target: string, branch: string, io: Pick<LegacyUnsafeIo, 'live' | 'sessions'> = {}): boolean {
  const row = findRow((io.sessions ?? loadHistory)(), target, branch);
  if (!row?.launchedUnsafe) return true;
  if (agentsOf(sessionIdFor(row), io).length) return false;
  clearLaunchedUnsafe(target, branch);
  return true;
}
