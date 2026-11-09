import { agentOf, liveAgents } from '../agents/index.js';
import { ASSISTANT_ID, assistantDir } from '../agents/assistant.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { findSession } from '../sessions/web-state.js';
import { shownState } from '../status/turn-activity.js';
import { listProcesses, runningFromNames, type RunningProcess } from '../platform/running-from.js';
import type { SleepChecks } from './idle-sleep.js';

/**
 * The real I/O behind idle sleep's checks (`stillAtWork`): the status the
 * dashboard shows, Claude Code's own process state, the background commands
 * in its conversation, and what runs from its folders. One per sweep: the
 * process list (slow on Windows) is read once, and only when a candidate gets
 * that far. A PTY whose session is gone stays awake (nothing to judge it by).
 */
export function sleepChecks(): SleepChecks {
  let procs: Promise<RunningProcess[]> | null = null;
  const live = liveAgents();
  const sessionOf = (id: string): WorktreeSession => {
    // The Ctrl+K assistant has no session: its folder stands in (its conversation, what runs from it).
    if (id === ASSISTANT_ID)
      return { target: ASSISTANT_ID, branch: '', isGroup: false, paths: [assistantDir()], createdAt: '', lastAccessedAt: '' };
    const s = findSession(id);
    if (!s) throw new Error('its session is gone');
    return s;
  };
  return {
    // The assistant reports no hook status: Claude Code's own state (live) speaks for it.
    shown: (id) => (id === ASSISTANT_ID ? null : shownState(sessionOf(id))),
    live: (_id, pid) => live.find((a) => a.pid === pid)?.state ?? null,
    backgroundCommands: (id, sinceMs) => {
      const s = sessionOf(id);
      return agentOf(s).conversation?.backgroundCommands?.(s, sinceMs) ?? 0;
    },
    runningFrom: (id) => {
      procs ??= listProcesses();
      const list = procs;
      return runningFromNames(sessionOf(id).paths, () => list);
    },
  };
}
