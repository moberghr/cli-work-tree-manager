// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RepoShipState, SessionAttention, SessionSummary, ShipPreflight } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchShipPreflight: vi.fn(),
  ship: vi.fn(),
  setArchived: vi.fn(),
}));
/** The fake setArchived, through the in-flight store as the real one goes (archive-pending.ts). */
const trackedSetArchived = vi.hoisted(() => async () => {
  const { trackArchive } = await import('../../src/web/src/api/archive-pending.js');
  return { setArchived: (id: string, archived: boolean) => trackArchive(id, archived, h.setArchived(id, archived)) };
});
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  ...(await trackedSetArchived()),
  fetchShipPreflight: h.fetchShipPreflight,
  ship: h.ship,
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/components/Diff/DiffView.js', () => ({ DiffView: () => null }));
vi.mock('../../src/web/src/components/Terminal/PtyView.js', () => ({ PtyView: () => null }));

import { ShipPanel, shipAvailability } from '../../src/web/src/components/Dashboard/ShipPanel.js';
import { SessionDetail } from '../../src/web/src/components/Dashboard/SessionDetail.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sess-1',
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/api/feat-x'],
  createdAt: minsAgo(100),
  lastAccessedAt: minsAgo(10),
  ...over,
});
const repo = (over: Partial<RepoShipState> = {}): RepoShipState => ({
  name: 'api',
  path: '/wt/api/feat-x',
  branch: 'feat/x',
  localSha: 'abc',
  dirtyFiles: 0,
  hasUpstream: true,
  tracksRemote: true,
  ahead: 0,
  behind: 0,
  pr: null,
  done: false,
  mergeBlockers: [],
  ...over,
});
const openPr = {
  number: 12,
  url: 'https://gh/pr/12',
  state: 'OPEN' as const,
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass' as const,
  headSha: 'abc',
};
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label))!;

async function openPanel(pre: ShipPreflight, onMerged = vi.fn()) {
  h.fetchShipPreflight.mockResolvedValue(pre);
  act(() => root.render(createElement(ShipPanel, { session: session(), onClose: () => {}, onMerged })));
  await flush();
  return onMerged;
}

describe('shipAvailability', () => {
  it('a dirty tree blocks every action', () => {
    const a = shipAvailability({ repos: [repo({ dirtyFiles: 2, hasUpstream: false, ahead: null })] });
    expect(a).toMatchObject({ canPush: false, canCreatePr: false });
    expect(a.mergeable).toHaveLength(0);
    expect(a.dirty.map((r) => r.name)).toEqual(['api']);
  });
  it('unpushed → push + create PR; open clean PR → merge; blockers/draft block merge', () => {
    const unpushed = shipAvailability({ repos: [repo({ hasUpstream: false, tracksRemote: false, ahead: null })] });
    expect(unpushed).toMatchObject({ canPush: true, canCreatePr: true });
    expect(unpushed.mergeable).toHaveLength(0);
    const open = shipAvailability({ repos: [repo({ pr: openPr })] });
    expect(open).toMatchObject({ canPush: false, canCreatePr: false });
    expect(open.mergeable.map((r) => r.name)).toEqual(['api']);
    expect(shipAvailability({ repos: [repo({ pr: openPr, mergeBlockers: ['Checks failing'] })] }).mergeable).toHaveLength(0);
    expect(shipAvailability({ repos: [repo({ ghError: 'gh not authenticated' })] }).canCreatePr).toBe(false);
  });
});

describe('ShipPanel', () => {
  it('shows progress immediately while the preflight loads', () => {
    h.fetchShipPreflight.mockReturnValue(new Promise(() => {}));
    act(() => root.render(createElement(ShipPanel, { session: session(), onClose: () => {}, onMerged: () => {} })));
    expect(text(container.querySelector('[role="status"]'))).toContain('Checking branch');
    expect(button('Push').disabled).toBe(true);
  });

  it('dirty tree: explains and blocks', async () => {
    await openPanel({ repos: [repo({ dirtyFiles: 3 })] });
    expect(text(container)).toContain('3 uncommitted files');
    expect(text(container)).toContain('commit or stash first');
    expect(button('Push').disabled).toBe(true);
    expect(button('Create PR').disabled).toBe(true);
    expect(button('Merge…').disabled).toBe(true);
  });

  it('no PR: Create PR sends the draft flag, shows progress, then results', async () => {
    await openPanel({ repos: [repo({ hasUpstream: false, ahead: null })] });
    expect(text(container)).toContain('not pushed');
    expect(text(container)).toContain('no PR yet');
    let resolve!: (v: unknown) => void;
    h.ship.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    act(() => container.querySelector<HTMLInputElement>('.wd-ship-inline input')!.click());
    act(() => button('Create PR').click());
    expect(h.ship).toHaveBeenCalledWith('sess-1', { action: 'create-pr', draft: true });
    expect(text(container.querySelector('[role="status"]'))).toContain('Creating PR…');
    h.fetchShipPreflight.mockResolvedValue({ repos: [repo({ pr: openPr })] });
    await act(async () => resolve({ results: [{ repo: 'api', ok: true, message: 'PR #12 opened', url: 'https://gh/pr/12' }] }));
    await flush();
    expect(text(container.querySelector('.wd-ship-results'))).toContain('✓ api — PR #12 opened');
  });

  it('open clean PR: merge needs an explicit confirm, then archives and hands back', async () => {
    const onMerged = await openPanel({ repos: [repo({ pr: openPr })] });
    expect(text(container)).toContain('#12 open · checks pass · clean');
    act(() => {
      const sel = container.querySelector<HTMLSelectElement>('select[aria-label="Merge method"]')!;
      sel.value = 'rebase';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Merge…').click());
    expect(h.ship).not.toHaveBeenCalled();
    const confirm = text(container.querySelector('[role="alertdialog"]'));
    expect(confirm).toContain('Merge api #12 (abc) with rebase?');
    expect(confirm).toContain('the session is archived');
    h.ship.mockResolvedValue({ results: [{ repo: 'api', ok: true, message: 'merged' }], archived: true });
    await act(async () => button('Confirm merge').click());
    // The SHA the panel showed goes to the server — it refuses if the PR moved.
    expect(h.ship).toHaveBeenCalledWith('sess-1', { action: 'merge', method: 'rebase', repos: [{ name: 'api', headSha: 'abc' }] });
    expect(onMerged).toHaveBeenCalled();
  });

  it('lists merge blockers and surfaces action errors', async () => {
    await openPanel({
      repos: [repo({ pr: { ...openPr, mergeStateStatus: 'BLOCKED' }, mergeBlockers: ['Required review missing', 'Checks failing'] })],
    });
    const blockers = [...container.querySelectorAll('.wd-ship-blockers li')].map((li) => li.textContent);
    expect(blockers).toEqual(['Required review missing', 'Checks failing']);
    expect(button('Merge…').disabled).toBe(true);
  });

  it('shows a readable error when an action fails', async () => {
    await openPanel({ repos: [repo({ hasUpstream: false, ahead: null })] });
    h.ship.mockRejectedValue(new Error('{"error":"push rejected: non-fast-forward"}'));
    await act(async () => button('Push').click());
    expect(text(container.querySelector('.wd-modal-error'))).toBe('push rejected: non-fast-forward');
  });
});

describe('Session header strip', () => {
  const att = (state: SessionAttention['state'], seen: boolean, summary: string): SessionAttention => ({
    state,
    seen,
    since: minsAgo(4),
    updatedAt: minsAgo(4),
    summary,
    stale: false,
  });
  const renderDetail = (s: SessionSummary) =>
    act(() =>
      root.render(
        createElement(SessionDetail, {
          session: s,
          subTab: 'diff',
          onSelectSubTab: () => {},
          onBack: () => {},
          backLabel: 'Sessions',
          onDelete: () => {},
          prs: [
            {
              number: 7,
              title: 't',
              branch: 'feat/x',
              url: 'https://gh/7',
              isDraft: false,
              checksStatus: 'PENDING',
              reviewDecision: 'NONE',
              myReview: 'NONE',
              isMine: true,
              repoAlias: 'api',
            },
          ],
        }),
      ),
    );

  it.each([
    ['needs_input', false, 'Needs your input · 4m — Claude needs your permission to use Bash'],
    ['working', true, 'Working · 4m — Refactor the ledger'],
    ['idle', false, 'Done · 4m — Added the endpoint'],
  ] as const)('%s: says what it is doing', (state, seen, expected) => {
    const summary = expected.split(' — ')[1];
    renderDetail(session({ attention: att(state, seen, summary), diffStat: { added: 3, deleted: 1, files: 1 } }));
    expect(text(container.querySelector('.wd-status-line'))).toBe(expected);
    expect(text(container.querySelector('.wd-session-strip .wd-diffstat'))).toBe('+3 −1');
    expect(container.querySelector('.wd-session-strip a.wd-pr-chip')?.textContent).toBe('#7');
  });

  it('Archive shows progress and flips to an Archived pill + Unarchive', async () => {
    let resolve!: (v: unknown) => void;
    h.setArchived.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderDetail(session());
    act(() => button('Archive').click());
    expect(h.setArchived).toHaveBeenCalledWith('sess-1', true);
    expect(button('Archiving…').disabled).toBe(true);
    await act(async () => resolve({ ok: true }));
    renderDetail(session({ archivedAt: minsAgo(0) }));
    expect(text(container.querySelector('.wd-archived-pill'))).toBe('archived');
    expect(button('Restore')).toBeDefined();
  });

  it('Ship ▾ opens the ship panel', async () => {
    h.fetchShipPreflight.mockResolvedValue({ repos: [repo()] });
    renderDetail(session());
    await act(async () => button('Ship ▾').click());
    expect(container.querySelector('[role="dialog"][aria-label="Ship session"]')).not.toBeNull();
    expect(h.fetchShipPreflight).toHaveBeenCalledWith('sess-1');
  });

  describe('groups — shipped in parts, carefully', () => {
    const be = (over: Partial<RepoShipState> = {}) =>
      repo({ name: 'backend', path: '/wt/shop/backend', pr: { ...openPr, headSha: 'b1' }, ...over });
    const fe = (over: Partial<RepoShipState> = {}) =>
      repo({ name: 'frontend', path: '/wt/shop/frontend', pr: { ...openPr, number: 13, headSha: 'f1' }, ...over });
    const docs = repo({ name: 'docs', path: '/wt/shop/docs', done: true, doneReason: 'untouched', commitsVsBase: 0 });
    const checkbox = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Merge ${name}"]`);

    it('a merged or untouched repo shows as done, never as blocked, and has no checkbox', async () => {
      await openPanel({ repos: [be({ done: true, doneReason: 'merged', pr: { ...openPr, state: 'MERGED' } }), fe(), docs] });
      expect(text(container)).toContain('backend feat/x ✓ merged');
      expect(text(container)).toContain('untouched, nothing to ship');
      expect(checkbox('backend')).toBeNull();
      expect(checkbox('docs')).toBeNull();
      expect(checkbox('frontend')?.checked).toBe(true);
      // Finishing the group: frontend is the only open repo → archives after.
      act(() => button('Merge').click());
      expect(text(container.querySelector('[role="alertdialog"]'))).toContain('the session is archived');
    });

    it('deselecting a repo merges only the rest, says the session stays open, and sends only their SHAs', async () => {
      await openPanel({ repos: [be(), fe(), docs] });
      expect(button('Merge').textContent).toContain('Merge 2');
      act(() => checkbox('frontend')!.click());
      expect(button('Merge').textContent).toContain('Merge 1');
      act(() => button('Merge').click());
      const confirm = text(container.querySelector('[role="alertdialog"]'));
      expect(confirm).toContain('Merge backend #12 (b1)');
      expect(confirm).toContain('1 other repository stays open — the session stays until everything is done');
      h.ship.mockResolvedValue({
        results: [{ repo: 'backend', ok: true, merged: true, message: 'merged' }],
        archived: false,
        allDone: false,
      });
      h.fetchShipPreflight.mockResolvedValue({ repos: [be({ done: true, doneReason: 'merged' }), fe(), docs] });
      await act(async () => button('Confirm merge').click());
      expect(h.ship).toHaveBeenCalledWith('sess-1', { action: 'merge', method: 'squash', repos: [{ name: 'backend', headSha: 'b1' }] });
      await flush();
      // Not archived → the panel stays, refreshed: backend now done.
      expect(text(container)).toContain('backend feat/x ✓ merged');
    });

    it('a blocked repo cannot be selected; the ready one still can', async () => {
      await openPanel({ repos: [be(), fe({ mergeBlockers: ['checks failing'] }), docs] });
      expect(checkbox('frontend')).toBeNull();
      expect(checkbox('backend')?.checked).toBe(true);
      expect(text(container)).toContain('checks failing');
    });

    it('nothing selected → Merge is disabled', async () => {
      await openPanel({ repos: [be(), fe()] });
      act(() => checkbox('backend')!.click());
      act(() => checkbox('frontend')!.click());
      expect(button('Merge').disabled).toBe(true);
    });

    it('every repo done → says so', async () => {
      await openPanel({ repos: [be({ done: true, doneReason: 'merged' }), docs] });
      expect(text(container)).toContain('nothing left to ship');
    });
  });
});
