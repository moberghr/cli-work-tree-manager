import { readStatus } from '../../core/status/session-status.js';
import type { WaitDeps } from '../../core/sessions/session-control.js';

/** waitForTurn's I/O for the CLI: the hook-recorded status in state.db, polled. */
export const cliWaitDeps: WaitDeps = {
  status: (id) => {
    const s = readStatus(id);
    return s ? { state: s.state, since: s.since, ...(s.summary ? { summary: s.summary } : {}) } : null;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
