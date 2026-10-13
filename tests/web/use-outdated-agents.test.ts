// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentsWire, RestartWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { useOutdatedAgents } = await import('../../src/web/src/hooks/use-outdated-agents.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe('useOutdatedAgents', () => {
  it('how a restart went is said for that update only: the next update starts without it', async () => {
    let wire: AgentsWire = {
      installedAt: '2026-10-11T11:12:00.000Z',
      outdated: [{ id: 'a', tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: false }],
      queued: [],
    };
    const api = {
      fetchAgents: async () => wire,
      restartAgents: async (): Promise<RestartWire> => {
        wire = { ...wire, outdated: [] };
        return { now: ['a'], later: [], failed: [] };
      },
    };
    let hook!: ReturnType<typeof useOutdatedAgents>;
    function Harness() {
      hook = useOutdatedAgents(api);
      return null;
    }
    act(() => root.render(createElement(Harness)));
    await flush();
    act(() => hook.restart());
    await flush();
    expect(hook.note).toBe('1 session restarted.');
    // Days later Claude Code updates again, and a load (the 5-minute tick, agents-changed) reads it.
    wire = {
      ...wire,
      installedAt: '2026-10-20T08:00:00.000Z',
      outdated: [{ id: 'a', tool: 'claude', startedAt: '2026-10-12T09:00:00Z', busy: false }],
    };
    act(() => hook.reload());
    await flush();
    expect(hook.agents?.installedAt).toBe('2026-10-20T08:00:00.000Z');
    expect(hook.note).toBeNull();
  });
});
