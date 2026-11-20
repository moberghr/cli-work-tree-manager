import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { dbPtySessions } from '../../../src/core/pty/pty-sessions-file.js';

/** The PR watch's `runsUnsafe` as ci-routes wires it: the session by id, the pool's host pids, the running agents. Remove next release. */

const live = vi.hoisted(() => ({ agents: [] as Array<{ pid: number; cwd: string }>, hostPids: new Set<number>() }));
vi.mock('../../../src/core/agents/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/agents/index.js')>()),
  liveAgents: () =>
    live.agents.map((a) => ({ ...a, conversationId: 'c', busy: false, state: 'idle', stateAt: null, waitingFor: null, startedAt: null })),
}));
vi.mock('../../../src/core/pty/pty-pool.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/pty/pty-pool.js')>()),
  ptyPids: () => live.hostPids,
}));

const { watchRunsUnsafe } = await import('../../../src/server/routes/ci-routes.js');

const s: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/x'], createdAt: 'x', lastAccessedAt: 'x' };
const id = sessionIdFor(s);
const tool = { cmd: 'claude', flags: [], resumeFlag: '--continue' };

afterEach(() => {
  live.agents = [];
  live.hostPids = new Set();
  dbPtySessions.write({});
  saveHistory([]);
});

describe('ci-routes: watchRunsUnsafe', () => {
  it("an older host's entry; a direct launch from before running outside the host beside a current entry; neither", () => {
    saveHistory([s]);
    dbPtySessions.write({ [id]: { cwd: '/wt/x', tool, startedAt: 'x', ...{ unsafe: true } } as never });
    expect(watchRunsUnsafe(id)).toBe('old-host');

    saveHistory([{ ...s, launchedUnsafe: true }]);
    dbPtySessions.write({ [id]: { cwd: '/wt/x', tool, startedAt: 'y' } as never });
    live.agents = [
      { pid: 100, cwd: '/wt/x' },
      { pid: 200, cwd: '/wt/x' },
    ];
    live.hostPids = new Set([200]);
    expect(watchRunsUnsafe(id)).toBe('outside');
    live.hostPids = new Set([100, 200]);
    expect(watchRunsUnsafe(id)).toBeNull();
  });
});
