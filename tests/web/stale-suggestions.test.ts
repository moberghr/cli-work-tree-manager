// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import { prsKnownFrom, staleSuggestions, STALE_SUGGEST_MS } from '../../src/web/src/state/session-display.js';
import { InboxTab } from '../../src/web/src/components/Dashboard/tabs/InboxTab.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, target: 'api', branch: `feat/${id}`, isGroup: false, paths: [`/wt/${id}`], createdAt: ago(STALE_SUGGEST_MS * 3), lastAccessedAt: ago(STALE_SUGGEST_MS + 60_000),
  draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', lastActivity: null, activityState: 'stale', pendingForClaudeCount: 0,
  attention: null, diffStat: null, archivedAt: null, port: null, ...over,
} as SessionSummary);
const pr = { number: 1 } as PrInfo;

describe('staleSuggestions', () => {
  it('suggests sessions untouched two weeks with no open PR and no Claude, oldest first', () => {
    const list = [
      s('stale'),
      s('older', { lastAccessedAt: ago(STALE_SUGGEST_MS * 2) }),
      s('recent', { lastAccessedAt: ago(60_000) }),
      s('in-review'),
      s('running', { claudes: { inTerminal: 1, inApp: 0, busy: false, duplicate: false } }),
      s('archived', { archivedAt: ago(1000) }),
      s('snoozed'),
    ];
    const out = staleSuggestions(list, (x) => (x.id === 'in-review' ? [pr] : []), NOW, { snoozed: NOW + 1000 }, () => true);
    expect(out.map((x) => x.id)).toEqual(['older', 'stale']);
  });

  it('suggests nothing without a full PR answer: before the first list, gh failed, or a repo gh listed only partly', () => {
    const none = () => [];
    expect(staleSuggestions([s('a')], none, NOW)).toEqual([]); // no prsKnown given
    expect(staleSuggestions([s('a')], undefined, NOW, {}, () => true)).toEqual([]);
    expect(staleSuggestions([s('a')], none, NOW, {}, prsKnownFrom(null))).toEqual([]);
    expect(staleSuggestions([s('a')], none, NOW, {}, prsKnownFrom(['api']))).toEqual([]);
    expect(staleSuggestions([s('a')], none, NOW, {}, prsKnownFrom(['web'])).map((x) => x.id)).toEqual(['a']);
    // a group's sub-repos aren't known in the SPA: it needs every repo listed in full
    expect(staleSuggestions([s('g', { isGroup: true, target: 'shop' })], none, NOW, {}, prsKnownFrom(['web']))).toEqual([]);
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* */ }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Inbox: worth archiving?', () => {
  it('archives one on click, and Not now hides it', async () => {
    const onArchive = vi.fn(async () => {});
    act(() => root.render(createElement(InboxTab, { sessions: [s('a'), s('b')], onOpenSession: () => {}, onArchive, prsFor: () => [], prsKnown: () => true })));
    const section = () => container.querySelector('.wd-inbox-stale');
    expect(section()?.textContent).toContain('Worth archiving? (2)');
    const buttons = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.wd-inbox-stale button')].filter((b) => b.textContent === label);
    await act(async () => buttons('Archive')[0].click());
    expect(onArchive).toHaveBeenCalledWith('a');
    act(() => buttons('Not now')[1].click());
    expect(section()?.textContent).toContain('Worth archiving? (1)');
    expect(JSON.parse(localStorage.getItem('wd-stale-snoozed') ?? '{}')).toHaveProperty('b');
  });
});
