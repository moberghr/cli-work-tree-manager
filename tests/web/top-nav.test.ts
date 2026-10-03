// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ tasks: [{ id: 1, text: 'Fix the CSV export', done: false, createdAt: '' }] }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  fetchTasks: async () => ({ tasks: h.tasks }),
}));

import { TopNav } from '../../src/web/src/components/Dashboard/TopNav.js';
import { NowTodayToggle } from '../../src/web/src/components/Dashboard/NowTodayToggle.js';
import { TasksPanel } from '../../src/web/src/components/Dashboard/TasksPanel.js';
import { railDetails } from '../../src/web/src/components/Dashboard/SessionRail.js';

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
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const tabs = () =>
  [...container.querySelectorAll('[role="tab"]')].map((t) =>
    t.getAttribute('aria-selected') === 'true' ? `[${t.textContent}]` : t.textContent,
  );

describe('TopNav', () => {
  it('a short bar: Inbox (with its count), Sessions, PRs, Jira; no version, no scope pill', () => {
    act(() => root.render(createElement(TopNav, { active: 'inbox', onSelect: () => {}, onHome: () => {}, inboxCount: 3 })));
    expect(tabs()).toEqual(['[Inbox3]', 'Sessions', 'PRs', 'Jira']);
    expect(container.querySelector('.wd-dash-version')).toBeNull();
    expect(container.textContent).not.toMatch(/v\d|dev/);
  });

  it('Today and Clean up are Sessions views: Sessions shows as current', () => {
    act(() => root.render(createElement(TopNav, { active: 'today', onSelect: () => {}, onHome: () => {} })));
    expect(tabs()).toContain('[Sessions]');
    act(() => root.render(createElement(TopNav, { active: 'cleanup', onSelect: () => {}, onHome: () => {} })));
    expect(tabs()).toContain('[Sessions]');
  });
});

describe('NowTodayToggle', () => {
  it('says which view is on, and switches', () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(NowTodayToggle, { value: 'now', onChange })));
    const [now, today] = [...container.querySelectorAll('button')];
    expect(now.getAttribute('aria-pressed')).toBe('true');
    expect(today.getAttribute('aria-pressed')).toBe('false');
    act(() => today.click());
    expect(onChange).toHaveBeenCalledWith('today');
  });
});

describe('TasksPanel', () => {
  function Harness({ onPick }: { onPick: (t: unknown) => void }) {
    const [open, setOpen] = useState(false);
    return createElement(TasksPanel, { open, onOpenChange: setOpen, onPick });
  }
  const panel = () => container.querySelector('.wd-tasks-panel');

  it('opens under its button, lists the tasks, and Esc or a click elsewhere closes it', async () => {
    act(() => root.render(createElement(Harness, { onPick: () => {} })));
    expect(panel()).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.wd-topnav-btn')!.click());
    await flush();
    expect(panel()!.textContent).toContain('Fix the CSV export');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(panel()).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.wd-topnav-btn')!.click());
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });
});

describe('railDetails: what a one-line rail row keeps for its tooltip', () => {
  it('changes, PRs, notes for Claude, your note, where its Claude runs', () => {
    const s = {
      pendingForClaudeCount: 2,
      hasNote: true,
      agents: { total: 1, inTerminal: 1, inApp: 0, busy: false, duplicate: false },
    } as unknown as SessionSummary;
    expect(railDetails(s, '+5 −1', [{ number: 42 }])).toBe('\n+5 −1 · #42 · 2 waiting for Claude · has notes · running in a terminal');
    expect(railDetails({} as SessionSummary, null, [])).toBe('');
  });
});
