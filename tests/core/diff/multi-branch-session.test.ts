import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadManifest } from '../../../src/core/diff/checkpoint.js';
import { computeSessionRange, historyBranchRefs, sessionHistory, type SessionHistory } from '../../../src/core/diff/session-history.js';
import { workingBranch } from '../../../src/core/git/git-head.js';
import { readSessionBranches } from '../../../src/core/sessions/session-branches.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import {
  allHistoryItems,
  branchGroups,
  branchSelection,
  historyItems,
  lastTurn,
  selectionRange,
  turnBranchFor,
  type HistoryItem,
} from '../../../src/web/src/state/diff-history.js';
import { buildMultiBranchSession, type MultiBranchSession } from '../../functional/fixtures/multi-branch-session.js';

/**
 * The Diff tab end to end on one hard session (the fixture's story): two repos, six branches, six turns, a branch
 * merged and deleted, one left with only an uncommitted turn, one never committed. What the server lists
 * (`GET …/checkpoints`: the same calls as the route) and what the picker makes of it (the SPA's pure lists), per
 * repo on screen, and every branch's "All of it" diffed for real: only that branch's files.
 */
let tmp: string;
let fx: MultiBranchSession;
let entries: ReturnType<typeof loadManifest>['entries'];
let history: SessionHistory;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-branch-'));
  fx = await buildMultiBranchSession(tmp);
  entries = loadManifest(fx.scopeHash).entries;
  // As the route builds it.
  history = await sessionHistory(fx.session, historyBranchRefs(fx.session, readSessionBranches(sessionIdFor(fx.session)), workingBranch));
}, 180_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** The picker for a repo on screen, as DiffView builds it. */
function picker(repo: 'api' | 'web', current: string) {
  const turnBranch = turnBranchFor(repo, current);
  return {
    own: historyItems(entries, history.commits, repo, turnBranch),
    groups: branchGroups(history.commits, repo, entries, turnBranch),
    all: allHistoryItems(entries, history.commits, repo, turnBranch),
  };
}
const label = (i: HistoryItem) => (i.kind === 'commit' ? i.title : i.kind === 'turn' ? i.tag : 'Uncommitted');
/** The files a selection's diff shows, per repo with any. */
function filesOf(items: HistoryItem[], sel: ReturnType<typeof branchSelection>): Record<string, string[]> {
  const r = selectionRange(items, sel!);
  if (!r) throw new Error('no range');
  const diff = computeSessionRange(fx.session, r.from, r.to);
  if ('error' in diff) throw new Error(diff.error);
  return Object.fromEntries(diff.repos.filter((x) => x.files.length).map((x) => [x.name, x.files.map((f) => f.path).sort()]));
}

describe('a session that worked on six branches in two repos: what the Diff tab shows', () => {
  it('every turn is kept across the branch switches, each recording its branches', () => {
    expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(entries.map((e) => e.branches?.api)).toEqual([
      'feat/orders',
      'feat/orders',
      'feat/orders',
      'fix/refunds',
      'fix/refunds',
      'scratch/try',
      'feat/export',
    ]);
    expect(entries.at(-1)?.branches?.web).toBe('feat/orders-ui');
  });

  it('the server lists every other branch with its own commits — the merged and deleted one too — and a span each', () => {
    const byBranch = (repo: string) =>
      Object.fromEntries(
        [...new Set(history.commits.filter((c) => c.repo === repo && c.branch).map((c) => c.branch!))].map((b) => [
          b,
          history.commits.filter((c) => c.repo === repo && c.branch === b).map((c) => c.subject),
        ]),
      );
    expect(byBranch('api')).toEqual({ 'feat/orders': ['Validate orders', 'Add orders'], 'fix/refunds': ['Add refunds'] });
    expect(byBranch('web')).toEqual({ 'feat/orders': ['Web orders'] });
    // The checked-out branches' own commits, unmarked.
    expect(history.commits.filter((c) => !c.branch).map((c) => `${c.repo}:${c.subject}`)).toEqual(
      expect.arrayContaining(['api:Add export', 'web:Polish UI', 'web:Add UI']),
    );
    const span = (repo: string, branch: string) => history.spans.find((s) => s.repo === repo && s.branch === branch);
    expect(span('api', 'feat/orders')).toMatchObject({ tip: fx.sha.apiValidate }); // deleted: its recorded tip
    expect(span('api', 'fix/refunds')).toEqual({ repo: 'api', branch: 'fix/refunds', base: fx.sha.mainAfterMerge, tip: fx.sha.apiRefunds });
    // Never committed: a span at the commit it was made at, so its turn is diffed from there.
    expect(span('api', 'scratch/try')).toEqual({
      repo: 'api',
      branch: 'scratch/try',
      base: fx.sha.mainAfterMerge,
      tip: fx.sha.mainAfterMerge,
    });
    expect(span('web', 'feat/orders')).toMatchObject({ tip: fx.sha.webOrders });
    expect(history.spans.some((s) => s.branch === 'feat/export' || s.branch === 'feat/orders-ui')).toBe(false); // checked out
  });

  it('api on screen: its branch first, then each other branch with its commits and the turns taken on it, newest first', () => {
    const { own, groups } = picker('api', 'feat/export');
    expect(own.map(label)).toEqual(['Add export', 'Turn 6', 'Uncommitted']);
    // A group: each switch names its repo, the one on screen first.
    expect(own.find((i) => i.tag === 'Turn 6')?.switched).toBe('api: scratch/try → feat/export');
    expect(groups.map((g) => [g.branch, g.items.map(label)])).toEqual([
      ['scratch/try', ['Turn 5']],
      ['fix/refunds', ['Turn 4', 'Turn 3', 'Add refunds']],
      ['feat/orders', ['Turn 2', 'Validate orders', 'Turn 1', 'Add orders']],
    ]);
  });

  it("web on screen: the same turns by web's own branches", () => {
    const { own, groups } = picker('web', 'feat/orders-ui');
    // feat/orders-ui was made from feat/orders: "Web orders" is in what it has checked out (its own history) and
    // in feat/orders' section too, each its own row.
    expect(own.map(label)).toEqual(['Web orders', 'Add UI', 'Turn 3', 'Turn 4', 'Turn 5', 'Polish UI', 'Turn 6', 'Uncommitted']);
    expect(groups.map((g) => [g.branch, g.items.map(label)])).toEqual([['feat/orders', ['Turn 2', 'Turn 1', 'Web orders']]]);
    // The switch marks say whose they are: web's own first, api's beside it (a turn's diff covers both repos).
    const switched = (tag: string) => own.find((i) => i.tag === tag)?.switched;
    expect(switched('Turn 3')).toBe('web: feat/orders → feat/orders-ui · api: feat/orders → fix/refunds');
    expect(switched('Turn 6')).toBe('api: scratch/try → feat/export');
    const keys = picker('web', 'feat/orders-ui').all.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('"Last turn" is turn 6 on either repo, never an older turn of another branch', () => {
    expect(lastTurn(picker('api', 'feat/export').all)).toMatchObject({ fromKey: 't:6', toKey: 't:6' });
    expect(lastTurn(picker('web', 'feat/orders-ui').all)).toMatchObject({ fromKey: 't:6', toKey: 't:6' });
  });

  it("each branch's All of it is that branch's files alone, diffed for real", () => {
    const api = picker('api', 'feat/export').all;
    expect(filesOf(api, branchSelection(api, 'feat/orders', history.spans, 'api'))).toEqual({ api: ['orders.cs'] });
    // Its commit and the turn after it left uncommitted: refunds.cs, nothing of main or the other branches.
    expect(filesOf(api, branchSelection(api, 'fix/refunds', history.spans, 'api'))).toEqual({ api: ['refunds.cs'] });
    // Only an uncommitted turn, and that turn was the switch: from the commit it was at, not fix/refunds' turn.
    expect(filesOf(api, branchSelection(api, 'scratch/try', history.spans, 'api'))).toEqual({ api: ['try.cs'] });
    const web = picker('web', 'feat/orders-ui').all;
    expect(filesOf(web, branchSelection(web, 'feat/orders', history.spans, 'web'))).toEqual({ web: ['orders.tsx'] });
  });

  it('one turn picked alone on another branch shows what that turn did', () => {
    const api = picker('api', 'feat/export').all;
    const t4 = api.find((i) => i.tag === 'Turn 4')!;
    expect(filesOf(api, { kind: 'range', fromKey: t4.key, toKey: t4.key })).toEqual({ api: ['refunds.cs'] });
  });
});
