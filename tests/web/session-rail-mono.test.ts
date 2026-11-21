// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A branch's name and a time are set in monospace (.wd-mono) in the rail: but a title you gave a session is
 * words, not a branch, and "in review" or "snoozed" are words, not a time.
 */
const now = new Date().toISOString();
const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    target: 'api',
    branch: `feat/${id}`,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: now,
    lastAccessedAt: now,
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    lastActivity: null,
    activityState: 'stale',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
    ...over,
  }) as SessionSummary;

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

/** The row whose name (its branch, or the title you gave it) is this. */
const row = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('.wd-dash-rail-item')].find(
    (b) => b.querySelector('.wd-dash-rail-name')?.textContent === name,
  )!;

describe('the rail sets a branch and a time in monospace, not words', () => {
  it('a branch’s name and its age are monospace; a title you gave it and "snoozed" are not', () => {
    const sessions = [
      session('plain'),
      session('titled', { title: 'Refunds', titleIsYours: true }),
      session('snoozy', { snoozed: { until: new Date(Date.now() + 3600_000).toISOString() } } as Partial<SessionSummary>),
    ];
    act(() =>
      root.render(
        createElement(SessionRail, { sessions, activeSessionId: null, onSelect: vi.fn(), onNewWorktree: () => {} } as Parameters<
          typeof SessionRail
        >[0]),
      ),
    );
    const name = (r: HTMLElement) => r.querySelector('.wd-dash-rail-name')!;
    const slot = (r: HTMLElement) => r.querySelector('.wd-dash-rail-slot')!;

    const plain = row('feat/plain');
    expect(name(plain).textContent).toBe('feat/plain');
    expect(name(plain).classList.contains('wd-mono')).toBe(true);
    // Its age ("just now", "4m"): a time.
    expect(slot(plain).classList.contains('wd-mono')).toBe(true);

    const titled = row('Refunds');
    expect(name(titled).textContent).toBe('Refunds');
    expect(name(titled).classList.contains('wd-mono')).toBe(false);

    const snoozy = row('feat/snoozy');
    expect(slot(snoozy).textContent).toBe('snoozed');
    expect(slot(snoozy).classList.contains('wd-mono')).toBe(false);
  });
});
