// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActivityWire } from '../../src/core/api-types.js';

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
import { ActivityIndicator, countdown } from '../../src/web/src/components/Dashboard/ActivityIndicator.js';
import { VERSION } from '../../src/web/src/version.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const RUNNING: ActivityWire = {
  running: [
    {
      id: 3,
      kind: 'pr-watch',
      label: 'Checking pull requests',
      startedAt: ago(4000),
      endedAt: null,
      status: 'running',
      progress: { done: 5, total: 13 },
      summary: null,
      notes: [],
    },
  ],
  recent: [
    {
      id: 2,
      kind: 'pr-watch',
      label: 'Checking pull requests',
      startedAt: ago(200_000),
      endedAt: ago(190_000),
      status: 'done',
      progress: { done: 13, total: 13 },
      summary: '13 sessions · 6 open PRs · 11 unresolved review threads',
      notes: [
        { at: ago(195_000), level: 'action', text: 'acme fix/x: archived: every PR merged, nothing uncommitted', sessionId: 's1' },
        { at: ago(195_000), level: 'info', text: 'api feat/y: a PR is merged, but kept: 2 uncommitted files', sessionId: 's2' },
      ],
    },
    {
      id: 1,
      kind: 'jira',
      label: 'Fetching your Jira issues',
      startedAt: ago(300_000),
      endedAt: ago(299_000),
      status: 'failed',
      progress: null,
      summary: 'Jira CLI (acli) not available or not logged in',
      notes: [],
    },
  ],
  schedules: [
    { kind: 'pr-watch', label: 'Pull request check', everyMs: 180_000, nextAt: inMs(95_000), pausedUntil: null, pausedWhy: null },
    { kind: 'idle-sleep', label: 'Idle Claude check', everyMs: 300_000, nextAt: inMs(60_000), pausedUntil: null, pausedWhy: null },
  ],
};

describe('ActivityIndicator', () => {
  it('says what runs now, with progress, in the top bar', async () => {
    act(() => root.render(createElement(ActivityIndicator, { onOpenSession: () => {}, load: async () => RUNNING })));
    await flush();
    // A grey dot (nothing needs you; the Jira failure never worked here, so it's not set up rather than broken).
    const dot = container.querySelector<HTMLButtonElement>('.wd-activity-dot-btn')!;
    expect(dot.textContent).toBe('');
    expect(dot.classList.contains('wd-activity-attention')).toBe(false);
    expect(dot.getAttribute('aria-label')).toBe('Background jobs: Checking pull requests 5/13');
  });

  it('the panel shows now, coming up, and recent runs with their decisions; a decision opens its session', async () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(ActivityIndicator, { onOpenSession: onOpen, load: async () => RUNNING })));
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('.wd-activity-dot-btn')!.click());
    const panel = container.querySelector('.wd-activity-panel')!;
    expect(panel.textContent).toContain('Pull request check every 3 min · next in 1:3'); // 1:35, give or take a tick
    expect(panel.textContent).toContain('13 sessions · 6 open PRs · 11 unresolved review threads');
    expect(panel.textContent).toContain('kept: 2 uncommitted files');
    expect(panel.querySelector('.wd-activity-run-failed')!.textContent).toContain('Jira CLI (acli) not available');
    const archived = [...panel.querySelectorAll<HTMLButtonElement>('.wd-activity-note button')].find((b) =>
      b.textContent!.includes('archived'),
    )!;
    act(() => archived.click());
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('a resting job colours the dot, and the panel says until when and why', async () => {
    const resting: ActivityWire = {
      running: [],
      recent: [],
      schedules: [
        {
          kind: 'pr-watch',
          label: 'Pull request check',
          everyMs: 180_000,
          nextAt: inMs(10_000),
          pausedUntil: inMs(9 * 60_000),
          pausedWhy: "GitHub's API limit is spent",
        },
      ],
    };
    act(() => root.render(createElement(ActivityIndicator, { onOpenSession: () => {}, load: async () => resting })));
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>('.wd-activity-dot-btn')!;
    expect(toggle.classList.contains('wd-activity-attention')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe("Background jobs: Pull request check is resting: GitHub's API limit is spent");
    act(() => toggle.click());
    expect(container.querySelector('.wd-activity-panel')!.textContent).toContain('resting until');
    expect(container.querySelector('.wd-activity-panel')!.textContent).toContain("GitHub's API limit is spent");
  });

  it("the panel is about background jobs only: the version is Help's (HelpMenu)", async () => {
    act(() => root.render(createElement(ActivityIndicator, { onOpenSession: () => {}, load: async () => RUNNING })));
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('.wd-activity-dot-btn')!.click());
    expect(container.querySelector('.wd-activity-dot-btn')!.getAttribute('aria-label')).not.toMatch(/Background jobs: Background jobs/);
    expect(container.querySelector('.wd-activity-panel')!.textContent).not.toContain(`work v${VERSION}`);
  });

  it('counts down', () => {
    const now = Date.parse('2026-09-30T10:00:00Z');
    expect(countdown('2026-09-30T10:01:05Z', now)).toBe('in 1:05');
    expect(countdown('2026-09-30T09:59:00Z', now)).toBe('now');
    expect(countdown('2026-09-30T12:00:00Z', now)).toBe('in 2 h');
  });
});
