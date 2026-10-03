// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DevServerState } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  state: null as unknown as DevServerState,
  actions: [] as string[],
  fail: null as string | null,
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/client.js', async (importActual) => ({
  ...(await importActual<object>()),
  fetchDevState: async () => h.state,
  devAction: async (_id: string, a: string) => {
    h.actions.push(a);
    if (h.fail) throw new Error(h.fail);
  },
}));
import { DevChip } from '../../src/web/src/components/Dashboard/DevChip.js';

const base: DevServerState = {
  port: 3017,
  listening: false,
  url: 'http://localhost:3017/',
  command: 'npm run dev',
  repo: 'web',
  running: null,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.state = { ...base };
  h.actions = [];
  h.fail = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async () => {
  await act(async () => root.render(createElement(DevChip, { sessionId: 's1' })));
  await act(async () => {});
};
const btn = (text: RegExp) => [...container.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));

describe('DevChip', () => {
  it('shows the port and offers to start the configured command', async () => {
    await render();
    expect(container.textContent).toContain(':3017');
    expect(container.querySelector('.wd-dev-preview')).toBeNull();
    await act(async () => btn(/Start dev/)!.click());
    expect(h.actions).toEqual(['start']);
  });

  it('links the preview when something serves on the port, and stops what it started', async () => {
    h.state = { ...base, listening: true, running: { pid: 1, startedAt: '' } };
    await render();
    const a = container.querySelector<HTMLAnchorElement>('.wd-dev-preview')!;
    expect(a.href).toBe('http://localhost:3017/');
    expect(a.target).toBe('_blank');
    expect(btn(/Start dev/)).toBeUndefined();
    await act(async () => btn(/Stop/)!.click());
    expect(h.actions).toEqual(['stop']);
  });

  it('a server you started yourself gets Preview but no Stop', async () => {
    h.state = { ...base, listening: true, command: null };
    await render();
    expect(container.querySelector('.wd-dev-preview')).not.toBeNull();
    expect(btn(/Stop|Start/)).toBeUndefined();
  });

  it('shows why a start failed', async () => {
    h.fail = 'already running (pid 9)';
    await render();
    await act(async () => btn(/Start dev/)!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('already running (pid 9)');
  });

  it('renders nothing for a worktree without a port', async () => {
    h.state = { ...base, port: null };
    await render();
    expect(container.textContent).toBe('');
  });
});
