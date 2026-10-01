// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const h = vi.hoisted(() => ({ openInTerminal: vi.fn() }));

vi.mock('../../src/web/src/api/panes.js', () => ({ openInTerminal: h.openInTerminal }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
// Keep the detail view light — the button is what's under test.
vi.mock('../../src/web/src/components/Diff/DiffView.js', () => ({ DiffView: () => null }));
vi.mock('../../src/web/src/components/Terminal/PtyView.js', () => ({ PtyView: () => null }));
vi.mock('../../src/web/src/components/Dashboard/tabs/SessionsTab.js', () => ({
  TrashIcon: () => null,
}));

import { SessionDetail } from '../../src/web/src/components/Dashboard/SessionDetail.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.openInTerminal.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session: SessionSummary = {
  id: 'sess-1',
  target: 'repo',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
};

function render() {
  act(() => {
    root.render(
      createElement(SessionDetail, {
        session,
        subTab: 'diff',
        onSelectSubTab: () => {},
        onBack: () => {},
        backLabel: 'Sessions',
        onDelete: () => {},
      }),
    );
  });
  return () => container.querySelector<HTMLButtonElement>('.wd-session-detail-action')!;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Open in terminal button', () => {
  it('sits in the session header, ahead of Catch me up, Prompts, Ship, Archive and Delete', () => {
    const button = render();
    expect(button().textContent).toBe('Open in terminal ↗');
    const header = button().closest('.wd-session-detail-header')!;
    const order = [...header.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(order.slice(-6)).toEqual(['Open in terminal ↗', expect.stringContaining('atch me up'), 'Prompts ▾', 'Ship ▾', 'Archive', 'Delete']);
  });

  it('opens the session, showing a busy state until the request settles', async () => {
    const d = deferred<{ ok: true }>();
    h.openInTerminal.mockReturnValue(d.promise);
    const button = render();

    act(() => button().click());
    expect(h.openInTerminal).toHaveBeenCalledWith('sess-1');
    expect(button().textContent).toBe('Opening…');
    expect(button().disabled).toBe(true);

    await act(async () => { d.resolve({ ok: true }); });
    expect(button().textContent).toBe('Open in terminal ↗');
    expect(button().disabled).toBe(false);
  });

  it('shows a warning with the error as its tooltip when opening fails', async () => {
    h.openInTerminal.mockRejectedValue(new Error('Only Windows Terminal is supported so far'));
    const button = render();

    await act(async () => { button().click(); });
    expect(button().textContent).toBe('Open in terminal ⚠');
    expect(button().title).toBe('Only Windows Terminal is supported so far');
    expect(button().disabled).toBe(false);
  });

  it('can retry after a failure', async () => {
    h.openInTerminal.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true });
    const button = render();
    await act(async () => { button().click(); });
    await act(async () => { button().click(); });
    expect(h.openInTerminal).toHaveBeenCalledTimes(2);
    expect(button().textContent).toBe('Open in terminal ↗');
  });
});
