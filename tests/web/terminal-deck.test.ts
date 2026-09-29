// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A PtyView stand-in that records its lifetime: a remount would mean a new
// socket, a replay and possibly a Claude start — what the deck avoids.
const life = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));
vi.mock('../../src/web/src/components/Terminal/PtyView.js', () => ({
  PtyView: ({ sessionId, active }: { sessionId: string; active?: boolean }) => {
    useEffect(() => {
      life.mounts.push(sessionId);
      return () => { life.unmounts.push(sessionId); };
    }, [sessionId]);
    return createElement('div', { 'data-pty': sessionId, 'data-active': String(active) });
  },
}));

import { TerminalDeck, nextDeck, DECK_SIZE } from '../../src/web/src/components/Terminal/TerminalDeck.js';

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, target: 'api', branch: id, isGroup: false, paths: [`/wt/${id}`],
  createdAt: '2026-09-30T08:00:00.000Z', lastAccessedAt: '2026-09-30T08:00:00.000Z', activityState: 'open',
  ...over,
} as SessionSummary);

let container: HTMLDivElement;
let root: Root;
let slot: HTMLDivElement;
beforeEach(() => {
  life.mounts.length = 0;
  life.unmounts.length = 0;
  container = document.createElement('div');
  slot = document.createElement('div');
  document.body.append(container, slot);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  slot.remove();
});

const render = (activeId: string | null, sessions: SessionSummary[], at: HTMLElement | null = slot) =>
  act(() => root.render(createElement(TerminalDeck, { activeId, slot: at, sessions })));
const shown = () =>
  [...container.querySelectorAll<HTMLElement>('.wd-term-deck-item')]
    .filter((el) => el.style.visibility === 'visible')
    .map((el) => el.querySelector('[data-pty]')!.getAttribute('data-pty'));

describe('nextDeck', () => {
  const alive = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
  it('puts the active session first and keeps the rest in recency order', () => {
    expect(nextDeck(['a', 'b', 'c'], 'b', alive)).toEqual(['b', 'a', 'c']);
    expect(nextDeck(['a', 'b'], null, alive)).toEqual(['a', 'b']);
  });
  it('drops the least recent beyond the size, and sessions that are gone', () => {
    expect(nextDeck(['a', 'b', 'c', 'd', 'e'], 'f', alive)).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(nextDeck(['a', 'b', 'c'], 'a', new Set(['a', 'c']))).toEqual(['a', 'c']);
    expect(nextDeck([], 'zzz', alive)).toEqual([]);
  });
});

describe('TerminalDeck', () => {
  const sessions = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => session(id));

  it('switching between sessions keeps each terminal mounted — back is instant', () => {
    render('a', sessions);
    render('b', sessions);
    render('a', sessions);
    expect(life.mounts).toEqual(['a', 'b']);
    expect(life.unmounts).toEqual([]);
    expect(shown()).toEqual(['a']);
  });

  it('hides everything (without unmounting) when no terminal tab is on screen', () => {
    render('a', sessions);
    render('a', sessions, null); // the session view went to its Diff tab
    expect(shown()).toEqual([]);
    render(null, sessions, null); // the Inbox
    expect(life.unmounts).toEqual([]);
    render('a', sessions);
    expect(shown()).toEqual(['a']);
    expect(life.mounts).toEqual(['a']);
  });

  it(`keeps at most ${DECK_SIZE}, closing the least recently used`, () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) render(id, sessions);
    expect(life.unmounts).toEqual(['a']);
    expect(container.querySelectorAll('.wd-term-deck-item')).toHaveLength(DECK_SIZE);
  });

  it('closes the terminal of a session that was archived or removed', () => {
    render('a', sessions);
    render('b', sessions);
    render('b', sessions.map((s) => (s.id === 'a' ? { ...s, archivedAt: '2026-09-30T09:00:00.000Z' } : s)));
    expect(life.unmounts).toEqual(['a']);
    render('c', sessions.filter((s) => s.id !== 'b'));
    expect(life.unmounts).toEqual(['a', 'b']);
  });

  it('only the shown terminal is active (the others must not resize the shared PTY)', () => {
    render('a', sessions);
    render('b', sessions);
    const active = [...container.querySelectorAll('[data-pty]')].map((el) => [el.getAttribute('data-pty'), el.getAttribute('data-active')]);
    expect(active).toEqual([['b', 'true'], ['a', 'false']]);
  });
});
