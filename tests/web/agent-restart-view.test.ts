// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentsWire } from '../../src/core/api-types.js';
import { outdatedNames, outdatedText, queuedText, restartLabel, restartSummary } from '../../src/web/src/state/agent-restart-view.js';
import { AgentsRestartCard } from '../../src/web/src/components/Dashboard/AgentsRestartCard.js';
import { HelpMenu } from '../../src/web/src/components/Dashboard/HelpMenu.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = (busy: boolean[], queued: string[] = []): AgentsWire => ({
  installedAt: '2026-10-11T11:12:00.000Z',
  outdated: busy.map((b, i) => ({ id: `s${i}`, tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: b })),
  queued,
});

describe('what the dashboard says about outdated agents', () => {
  it('the line, the button and how it went', () => {
    expect(outdatedText(agents([]))).toBeNull();
    expect(outdatedText(agents([false]))).toBe('Claude Code was updated: 1 session still runs the old version.');
    expect(outdatedText(agents([false, true, true]))).toBe('Claude Code was updated: 3 sessions still run the old version.');
    expect(restartLabel(agents([false, false]))).toBe('Restart them');
    expect(restartLabel(agents([false]))).toBe('Restart it');
    expect(restartLabel(agents([true]))).toBe('Restart it after its turn');
    expect(restartLabel(agents([false, true, true]))).toBe('Restart (1 now, 2 after their turns)');
    // Already asked: no button for them, the line says they wait.
    expect(restartLabel(agents([true, false], ['s0']))).toBe('Restart it');
    expect(restartLabel(agents([true], ['s0']))).toBeNull();
    expect(queuedText(agents([true], ['s0']))).toBe('1 restarts when its turn ends.');
    expect(restartSummary({ now: ['a', 'b'], later: ['c'], failed: [] })).toBe('2 sessions restarted · 1 restarts when its turn ends.');
    expect(restartSummary({ now: [], later: [], failed: [{ id: 'a', error: 'host said no' }] })).toBe("1 couldn't: host said no.");
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(label));

describe('AgentsRestartCard', () => {
  it('shows with outdated agents: Restart them asks; Later hides it until the tool updates again', () => {
    const onRestart = vi.fn();
    const render = (w: AgentsWire | null) =>
      act(() => root.render(createElement(AgentsRestartCard, { agents: w, onRestart, restarting: false, note: null })));
    render(agents([]));
    expect(container.textContent).toBe('');
    render(agents([false, false]));
    expect(container.textContent).toContain('2 sessions still run the old version');
    act(() => button('Restart them')!.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
    act(() => button('Later')!.click());
    expect(container.textContent).toBe('');
    render({ ...agents([false]), installedAt: '2026-10-20T08:00:00.000Z' }); // updated again
    expect(container.textContent).toContain('1 session still runs the old version');
  });
});

describe('HelpMenu: outdated agents', () => {
  it('a dot on the version, the line and Restart in the menu', () => {
    const onRestartAgents = vi.fn();
    act(() => root.render(createElement(HelpMenu, { agents: agents([false, true]), onRestartAgents })));
    expect(container.querySelector('.wd-help-btn')!.className).toContain('wd-help-btn-update');
    act(() => container.querySelector<HTMLButtonElement>('.wd-help-btn')!.click());
    expect(container.textContent).toContain('Claude Code was updated: 2 sessions still run the old version.');
    act(() => button('Restart (1 now, 1 after its turn)')!.click());
    expect(onRestartAgents).toHaveBeenCalledTimes(1);
  });
});

describe('which sessions still run the old version', () => {
  const sessions = [
    { id: 's0', target: 'api', branch: 'feat/x', title: 'Invoices', titleIsYours: true },
    { id: 's1', target: 'web', branch: 'fix/login', title: 'auto title', titleIsYours: false },
  ];
  it('named as the rail names them, the assistant as such, an unknown one by its id; the waiting ones last', () => {
    const w: AgentsWire = {
      installedAt: '2026-10-11T11:12:00.000Z',
      outdated: [
        { id: 's0', tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: true },
        { id: 's1', tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: false },
        { id: 'assistant', tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: false },
        { id: 'gone', tool: 'claude', startedAt: '2026-10-08T09:00:00Z', busy: false },
      ],
      queued: ['gone'],
    };
    expect(outdatedNames(w, sessions as never)).toEqual([
      { id: 's1', name: 'fix/login · web', waits: false },
      { id: 'assistant', name: 'the Ctrl+K assistant', waits: false },
      { id: 's0', name: 'Invoices · api', waits: true },
      { id: 'gone', name: 'gone', waits: true },
    ]);
    expect(outdatedNames(null, sessions as never)).toEqual([]);
  });

  it('the card lists them; a name opens its session, the waiting one says so', () => {
    const onOpen = vi.fn();
    const names = [
      { id: 's1', name: 'fix/login · web', waits: false },
      { id: 's0', name: 'Invoices · api', waits: true },
    ];
    act(() =>
      root.render(
        createElement(AgentsRestartCard, {
          agents: agents([false, true]),
          onRestart: () => {},
          restarting: false,
          note: null,
          names,
          onOpen,
        }),
      ),
    );
    const items = [...container.querySelectorAll('.wd-outdated-list li')].map((li) => li.textContent);
    expect(items).toEqual(['fix/login · web', 'Invoices · api · after its turn']);
    act(() => button('fix/login')!.click());
    expect(onOpen).toHaveBeenCalledWith('s1');
  });
});
