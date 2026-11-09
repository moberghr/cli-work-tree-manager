// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HistoryPicker } from '../../src/web/src/components/Diff/HistoryPicker.js';
import { BranchesLine } from '../../src/web/src/components/Dashboard/SessionBits.js';
import { BranchSwitch } from '../../src/web/src/components/Diff/BranchSwitch.js';
import {
  allHistoryItems,
  branchAt,
  branchGroups,
  branchSelection,
  branchSwitch,
  historyItems,
  inSelection,
  pick,
  selectionLabel,
  selectionRange,
  shownBranchOf,
  sinceLooked,
  turnBranchFor,
  SINCE_BRANCH,
  UNCOMMITTED,
  type DiffSelection,
} from '../../src/web/src/state/diff-history.js';
import { branchNote, branchUnpushed } from '../../src/web/src/state/branches.js';
import { prsForSession } from '../../src/web/src/state/session-display.js';
import { prSections } from '../../src/web/src/state/pr-tab.js';
import type { SessionBranchWire, SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import type { SessionCi, ShipPr } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (minute: number) => `2026-10-06T08:${String(minute).padStart(2, '0')}:00Z`;
const entry = (id: number, minute: number, branches?: Record<string, string | null>) => ({
  id,
  ts: at(minute),
  repos: {},
  ...(branches ? { branches } : {}),
});
const commit = (sha: string, minute: number, branch?: string) => ({
  repo: 'backend',
  sha: sha.padEnd(40, '0'),
  subject: `commit ${sha}`,
  at: at(minute),
  ...(branch ? { branch } : {}),
});

// The user's case: the checked-out branch fix/tests has one commit; fix/SD (made before it) has 9cb78ad.
const entries = [
  entry(0, 0, { backend: 'feat/webhook-improvements' }),
  entry(1, 10, { backend: 'feat/webhook-improvements' }),
  entry(2, 30, { backend: 'fix/tests-deterministic-culture' }),
];
const commits = [commit('a31a7f2', 25), commit('9cb78ad', 20, 'fix/SD-3999-probe-recovers-on-2xx')];

describe('the Diff picker: commits grouped by branch', () => {
  it("the checked-out branch's timeline leaves out the other branch's commits; they come after it, under their branch", () => {
    const own = historyItems(entries, commits, null);
    expect(own.map((i) => i.key)).toEqual(['t:1', `c:${'a31a7f2'.padEnd(40, '0')}`, 't:2', 'u']);
    const groups = branchGroups(commits, null);
    expect(groups.map((g) => [g.branch, g.items.map((i) => i.tag)])).toEqual([['fix/SD-3999-probe-recovers-on-2xx', ['9cb78ad']]]);
    const all = allHistoryItems(entries, commits, null);
    expect(all.at(-1)).toMatchObject({ tag: '9cb78ad', branch: 'fix/SD-3999-probe-recovers-on-2xx' });
    // "Everything on the branch" is the checked-out one's: the other branch's commit isn't marked.
    expect(inSelection(all, SINCE_BRANCH, all.at(-1)!.key)).toBe(false);
    expect(inSelection(all, SINCE_BRANCH, own[1].key)).toBe(true);
  });

  it("9cb78ad is one click away: a pick diffs that commit; a span never crosses branches; a branch's whole work by name", () => {
    const all = allHistoryItems(entries, commits, null);
    const sd = all.at(-1)!;
    expect(selectionRange(all, pick(sd.key))).toEqual({
      from: { kind: 'parent', repo: 'backend', sha: sd.after.kind === 'commit' ? sd.after.sha : '' },
      to: sd.after,
    });
    expect(selectionRange(all, pick(sd.key, 't:1'))).toBeNull(); // across branches: nothing (shows Uncommitted)
    const sel = branchSelection(all, 'fix/SD-3999-probe-recovers-on-2xx')!;
    expect(selectionLabel(all, sel)).toBe('fix/SD-3999-probe-recovers-on-2xx');
    expect(selectionRange(all, sel)?.to).toEqual(sd.after);
    expect(branchSelection(all, 'no/such')).toBeNull();
    // "Since you looked" stays on this branch's turns and commits.
    expect(sinceLooked(all, entries, 1)).toMatchObject({ fromKey: `c:${'a31a7f2'.padEnd(40, '0')}`, toKey: 'u' });
  });

  it('a turn that crossed a branch switch is marked; turns from before (no branches) never are', () => {
    const own = historyItems(entries, [], null);
    expect(own.find((i) => i.key === 't:2')?.switched).toBe('feat/webhook-improvements → fix/tests-deterministic-culture');
    expect(own.find((i) => i.key === 't:1')?.switched).toBeUndefined();
    expect(branchSwitch({}, { branches: { a: 'x' } })).toBeNull();
    expect(branchSwitch({ branches: { a: 'x' } }, { branches: { a: null } })).toBe('x → detached');
  });
});

describe('the Diff tab: everything the session worked on, by branch', () => {
  // Turns 1–2 were on feat/webhook (merged since), 3 is the switch to fix/tests, checked out now. A turn records each
  // repo by its root: the picker matches it by the folder's name.
  const root = 'C:\\wt\\backend';
  const turns = [
    entry(0, 0, { [root]: 'feat/webhook-improvements' }),
    entry(1, 5, { [root]: 'feat/webhook-improvements' }),
    entry(2, 8, { [root]: 'feat/webhook-improvements' }),
    entry(3, 30, { [root]: 'fix/tests-deterministic-culture' }),
  ];
  const webhook = commit('c0ffee1', 6, 'feat/webhook-improvements');
  const all = [commit('a31a7f2', 25), webhook];
  const turnBranch = turnBranchFor('backend', 'fix/tests-deterministic-culture');
  const spans = [{ repo: 'backend', branch: 'feat/webhook-improvements', base: 'b'.repeat(40), tip: webhook.sha }];

  it("a turn on another branch is listed under it, with that branch's commits; this branch's timeline keeps its own", () => {
    expect(branchAt({ [root]: 'x' }, 'backend')).toBe('x');
    expect(branchAt({ backend: 'y' }, 'backend')).toBe('y');
    expect(branchAt(undefined, 'backend')).toBeNull();
    const own = historyItems(turns, all, null, turnBranch);
    expect(own.map((i) => i.tag)).toEqual(['a31a7f2', 'Turn 3', 'Uncommitted']);
    const groups = branchGroups(all, null, turns, turnBranch);
    expect(groups.map((g) => [g.branch, g.items.map((i) => i.tag)])).toEqual([
      ['feat/webhook-improvements', ['Turn 2', 'c0ffee1', 'Turn 1']],
    ]);
    // Without the rule (an older caller): every turn is this branch's, as before.
    expect(historyItems(turns, all, null).filter((i) => i.kind === 'turn')).toHaveLength(3);
  });

  it("a branch's whole change is its span (base → tip), merged or not; without one, its commits; the switch names it", () => {
    const items = allHistoryItems(turns, all, null, turnBranch);
    const sel = branchSelection(items, 'feat/webhook-improvements', spans)!;
    expect(selectionRange(items, sel)).toEqual({
      from: { kind: 'commit', repo: 'backend', sha: 'b'.repeat(40) },
      to: items.find((i) => i.key === `c:${webhook.sha}`)!.after,
    });
    expect(selectionLabel(items, sel)).toBe('feat/webhook-improvements');
    expect(shownBranchOf(items, sel)).toBe('feat/webhook-improvements');
    expect(shownBranchOf(items, SINCE_BRANCH)).toBeNull();
    expect(shownBranchOf(items, pick('t:3'))).toBeNull();
    // No span known (an older server): the commits as one span, from the first one's parent.
    expect(selectionRange(items, branchSelection(items, 'feat/webhook-improvements')!)?.from).toEqual({
      kind: 'parent',
      repo: 'backend',
      sha: webhook.sha,
    });
  });

  it('the toolbar Branch switch: the checked-out one, then each other with what is known of it; a pick shows it', () => {
    const onPick = vi.fn<(b: string | null) => void>();
    act(() =>
      root_.render(
        createElement(BranchSwitch, {
          current: 'fix/tests-deterministic-culture',
          groups: branchGroups(all, null, turns, turnBranch),
          shownBranch: null,
          branches: [branch({ repo: 'backend', name: 'feat/webhook-improvements', commits: 0, pushed: true, unpushed: 0, merged: true })],
          repo: 'backend',
          onPick,
        }),
      ),
    );
    const select = container.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'fix/tests-deterministic-culture (checked out)',
      // Merged: "0 commits" would say its work is gone; it says merged.
      'feat/webhook-improvements · merged',
    ]);
    act(() => {
      select.value = 'feat/webhook-improvements';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith('feat/webhook-improvements');
    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it("the picker's branch heading has All of it: the branch's span", () => {
    const items = allHistoryItems(turns, all, null, turnBranch);
    const onSelect = vi.fn<(sel: DiffSelection) => void>();
    act(() =>
      root_.render(
        createElement(HistoryPicker, {
          items,
          selection: UNCOMMITTED,
          onSelect,
          lastTurn: null,
          sinceLooked: null,
          groups: branchGroups(all, null, turns, turnBranch),
          current: 'fix/tests-deterministic-culture',
          spans,
        }),
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-branch-all')!.click());
    expect(onSelect).toHaveBeenCalledWith(branchSelection(items, 'feat/webhook-improvements', spans));
  });
});

let container: HTMLDivElement;
let root: Root;
// The tests above name their repo's root `root`; this is the React root.
const root_ = { render: (el: Parameters<Root['render']>[0]) => root.render(el) };
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const branch = (over: Partial<SessionBranchWire>): SessionBranchWire => ({
  repo: 'api',
  name: 'x',
  current: false,
  firstSeen: at(0),
  lastSeen: at(1),
  exists: true,
  pushed: false,
  commits: 1,
  unpushed: 1,
  merged: false,
  ...over,
});
const wires: SessionBranchWire[] = [
  branch({ name: 'fix/tests-deterministic-culture', current: true }),
  branch({ name: 'fix/SD-3999-probe-recovers-on-2xx' }),
  branch({
    name: 'feat/webhook-improvements',
    pushed: true,
    unpushed: 0,
    commits: 0,
    merged: true,
    pr: { number: 3592, url: 'u/3592', state: 'MERGED', kind: 'merged' },
  }),
];

describe('HistoryPicker: other branches', () => {
  it("lists this branch's history, then each other branch with what's known of it; a click picks its commit", () => {
    const all = allHistoryItems(entries, commits, null);
    const onSelect = vi.fn<(sel: DiffSelection) => void>();
    act(() =>
      root.render(
        createElement(HistoryPicker, {
          items: all,
          selection: UNCOMMITTED,
          onSelect,
          lastTurn: null,
          sinceLooked: null,
          groups: branchGroups(commits, null),
          branches: wires,
          current: 'fix/tests-deterministic-culture',
        }),
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    const text = container.textContent ?? '';
    expect(text).toContain('On fix/tests-deterministic-culture (checked out)');
    expect(text).toContain('fix/SD-3999-probe-recovers-on-2xx · 1 commit · not pushed');
    expect(text).toContain('branch switched: feat/webhook-improvements → fix/tests-deterministic-culture');
    const row = [...container.querySelectorAll<HTMLButtonElement>('.wd-history-row')].find((b) => b.textContent?.includes('9cb78ad'))!;
    act(() => row.click());
    expect(onSelect).toHaveBeenCalledWith(pick(all.at(-1)!.key));
    // "Everything on the branch" counts this branch's commits only.
    expect(text).toContain('1 commit + uncommitted');
  });
});

describe('the header: Branches', () => {
  const session = (over: Partial<SessionSummary>): SessionSummary =>
    ({
      id: 's',
      target: 'straumur',
      branch: 'feat/webhook-improvements',
      isGroup: false,
      paths: [],
      createdAt: '',
      lastAccessedAt: '',
      ...over,
    }) as SessionSummary;

  it('nothing for a session on one branch; else each branch with its commits, pushed or not, its PR; a click shows it in the Diff', () => {
    act(() => root.render(createElement(BranchesLine, { session: session({}) })));
    expect(container.textContent).toBe('');
    const onShow = vi.fn();
    act(() => root.render(createElement(BranchesLine, { session: session({ branches: wires }), onShow })));
    const text = container.textContent ?? '';
    expect(text).toContain('Branches:');
    expect(text).toContain('fix/tests-deterministic-culture (checked out) 1 commit · not pushed');
    expect(text).toContain('fix/SD-3999-probe-recovers-on-2xx 1 commit · not pushed');
    expect(text).toContain('#3592 · merged');
    // The checked-out one isn't a link (it's what the Diff shows already); the others are.
    const link = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'fix/SD-3999-probe-recovers-on-2xx',
    )!;
    act(() => link.click());
    expect(onShow).toHaveBeenCalledWith('api', 'fix/SD-3999-probe-recovers-on-2xx');
    expect(container.querySelectorAll('.wd-branch-unpushed')).toHaveLength(2);
  });

  it('branchNote / branchUnpushed', () => {
    // Merged: its own commits are 0, which isn't news; the PR says it.
    expect(branchNote(wires[2])).toBe('PR #3592 merged');
    expect(branchNote(wires[2], false)).toBe('merged');
    expect(branchNote(branch({ exists: false }))).toBe('deleted');
    expect(branchNote(null)).toBeNull();
    expect(branchUnpushed(wires[2])).toBe(false);
    expect(branchUnpushed(wires[1])).toBe(true);
  });
});

describe('PRs across branches', () => {
  const pr = (n: number, state: ShipPr['state']): ShipPr => ({
    number: n,
    url: `u/${n}`,
    state,
    isDraft: false,
    mergeStateStatus: 'CLEAN',
    checks: 'pass',
    headSha: String(n),
  });
  it('the PR tab: the new open PR first, the merged one folded under it as earlier', () => {
    const ci: SessionCi = {
      checkedAt: at(0),
      repos: [
        {
          name: 'api',
          branch: 'fix/probe',
          pr: pr(3600, 'OPEN'),
          otherPrs: [{ branch: 'feat/webhooks', pr: pr(3592, 'MERGED') }],
          done: false,
        },
      ],
    };
    expect(prSections(ci, []).map((s) => [s.number, s.state, s.earlier ?? false, s.branch])).toEqual([
      [3600, 'OPEN', false, 'fix/probe'],
      [3592, 'MERGED', true, 'feat/webhooks'],
    ]);
  });
  it('the PR tab: two open PRs from two branches of one repo are both sections, neither folded', () => {
    const ci: SessionCi = {
      checkedAt: at(0),
      repos: [
        {
          name: 'api',
          branch: 'fix/probe',
          pr: pr(3656, 'OPEN'),
          otherPrs: [
            { branch: 'fix/culture', pr: pr(3657, 'OPEN') },
            { branch: 'feat/webhooks', pr: pr(3592, 'MERGED') },
          ],
          done: false,
        },
      ],
    };
    expect(prSections(ci, []).map((s) => [s.number, s.state, s.earlier ?? false, s.branch])).toEqual([
      [3657, 'OPEN', false, 'fix/culture'],
      [3656, 'OPEN', false, 'fix/probe'],
      [3592, 'MERGED', true, 'feat/webhooks'],
    ]);
  });

  it("the dashboard's PR list matches a PR on any branch the session worked on", () => {
    const listed = (branchName: string) => ({ branch: branchName, repoAlias: 'api', url: `l/${branchName}` }) as PrInfo;
    const s = {
      id: 's',
      target: 'api',
      branch: 'feat/webhooks',
      isGroup: false,
      branches: [branch({ name: 'fix/probe' })],
    } as SessionSummary;
    expect(prsForSession(s, [listed('fix/probe'), listed('other')]).map((p) => p.branch)).toEqual(['fix/probe']);
  });
});
