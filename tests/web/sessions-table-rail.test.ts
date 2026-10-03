// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { RailLayout } from '../../src/core/rail/rail-layout.js';
import { SessionsTab } from '../../src/web/src/components/Dashboard/tabs/SessionsTab.js';
import type { BulkActions } from '../../src/web/src/components/Dashboard/tabs/BulkBar.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rail's pins and sections in the Sessions table: on the rows, a filter, a grouping, and the bulk bar's Rail ▾. */

const now = new Date().toISOString();
const session = (id: string): SessionSummary =>
  ({ id, target: 'api', branch: `feat/${id}`, isGroup: false, paths: [`/wt/${id}`], createdAt: now, lastAccessedAt: now, activityState: 'stale' }) as SessionSummary;
const SESSIONS = [session('a'), session('b'), session('c')];
const LAYOUT: RailLayout = { sections: [{ id: 'x', name: 'Client X' }], places: { a: { pinned: true }, b: { section: 'x' } } };

let container: HTMLDivElement;
let root: Root;
let place: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('work-web:sessions-grouping', 'none');
  place = vi.fn(async () => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const bulk = { archive: vi.fn(), restore: vi.fn(), snooze: vi.fn(), send: vi.fn(), remove: vi.fn(), place } as unknown as BulkActions;
  act(() => root.render(createElement(SessionsTab, { sessions: SESSIONS, onOpenSession: () => {}, onNewWorktree: () => {}, onDeleteSession: () => {}, bulk, layout: LAYOUT })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const branches = () => [...container.querySelectorAll('tbody .wd-st-branch')].map((b) => b.textContent);
const select = (label: string, value: string) =>
  act(() => {
    const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('select')!;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

describe('the rail in the Sessions table', () => {
  it('each row says where it is in the rail: 📌, or its section', () => {
    const tags = Object.fromEntries([...container.querySelectorAll('tbody tr')].map((r) => [r.querySelector('.wd-st-branch')!.textContent, r.querySelector('.wd-st-rail')?.textContent ?? null]));
    expect(tags).toEqual({ 'feat/a': '📌', 'feat/b': 'Client X', 'feat/c': null });
  });

  it('a Rail filter: pinned, a section, in none', () => {
    select('Rail filter', 'pinned');
    expect(branches()).toEqual(['feat/a']);
    select('Rail filter', 'section:x');
    expect(branches()).toEqual(['feat/b']);
    select('Rail filter', 'none');
    expect(branches()).toEqual(['feat/c']);
  });

  it('grouped as the rail is', () => {
    select('Group', 'section');
    expect([...container.querySelectorAll('.wd-session-group-name')].map((n) => n.textContent)).toEqual(['Pinned', 'Client X', 'Other']);
  });

  it('an archived session isn’t in the rail’s groups (as in the rail): it has an Archived group of its own', () => {
    localStorage.setItem('work-web:sessions-show-archived', '1');
    act(() => root.unmount());
    root = createRoot(container);
    const archived = { ...session('d'), archivedAt: now } as SessionSummary;
    const layout: RailLayout = { ...LAYOUT, places: { ...LAYOUT.places, d: { pinned: true } } };
    act(() => root.render(createElement(SessionsTab, { sessions: [...SESSIONS, archived], onOpenSession: () => {}, onNewWorktree: () => {}, onDeleteSession: () => {}, layout })));
    select('Group', 'section');
    const groups = [...container.querySelectorAll('.wd-session-group')].map((g) => [g.querySelector('.wd-session-group-name')!.textContent, [...g.querySelectorAll('.wd-st-branch')].map((b) => b.textContent)]);
    expect(groups).toEqual([['Pinned', ['feat/a']], ['Client X', ['feat/b']], ['Other', ['feat/c']], ['Archived', ['feat/d']]]);
  });

  it('an archived session whose uncommitted files were saved says so (Restore puts them back)', () => {
    localStorage.setItem('work-web:sessions-show-archived', '1');
    act(() => root.unmount());
    root = createRoot(container);
    const archived = { ...session('d'), archivedAt: now, archive: { worktreeRemoved: true, keptBecause: null, promptCount: 0, prompts: [], lastSummary: null, savedUncommitted: 3 } } as SessionSummary;
    act(() => root.render(createElement(SessionsTab, { sessions: [archived], onOpenSession: () => {}, onNewWorktree: () => {}, onDeleteSession: () => {} })));
    const pill = container.querySelector('.wd-archived-pill')!;
    expect(pill.textContent).toBe('archived · folder removed · 3 changes saved');
    expect(pill.getAttribute('title')).toContain('and 3 uncommitted files. Restore recreates it and puts them back.');
    // What waited in it when a merged session was archived.
    act(() => root.render(createElement(SessionsTab, { sessions: [{ ...archived, archive: { ...archived.archive!, kept: '2 reply drafts' } }], onOpenSession: () => {}, onNewWorktree: () => {}, onDeleteSession: () => {} })));
    expect(container.querySelector('.wd-archived-pill')!.getAttribute('title')).toContain('Also kept: 2 reply drafts.');
  });

  it('the bulk bar pins them, or moves them into a section', async () => {
    for (const id of ['b', 'c']) act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select api feat/${id}"]`)!.click());
    const railBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Rail ▾')!;
    act(() => railBtn.click());
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes(label))!;
    await act(async () => item('Move to “Client X”').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), { pinned: false, section: 'x' });
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), { pinned: false, section: 'x' });
  });
});
