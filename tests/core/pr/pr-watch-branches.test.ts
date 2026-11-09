import { describe, it, expect, vi } from 'vitest';
import { autoArchiveVerdict, createPrWatch, type PrWatchDeps } from '../../../src/core/pr/pr-watch.js';
import { otherPrsOf, workElsewhere } from '../../../src/core/pr/branch-work.js';
import { prStageOf, stageRepos } from '../../../src/core/pr/pr-stage.js';
import { prStageWire } from '../../../src/core/sessions/session-wire.js';
import { branchFactsOf, watchBranchOptions } from '../../../src/core/pr/pr-watch-hosts.js';
import type { OtherBranchState, RepoShipState, ShipPr, ShipPreflight } from '../../../src/core/api-types.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import type { SessionBranches } from '../../../src/core/sessions/session-branches.js';

/**
 * The PR watch over every branch a session worked on (session-branches.ts): a PR merged on its own branch, then
 * Claude moved on to a new branch and a new PR. The stage shows the new open PR; the merged one folds under it; and
 * the session is never archived while a branch has commits not pushed or a PR open.
 */

const ENTERED = '2026-09-30T09:00:00Z';
const LATER = Date.parse(ENTERED) + 48 * 3600_000;
const session: WorktreeSession = {
  target: 'api',
  branch: 'feat/webhooks',
  isGroup: false,
  paths: [],
  createdAt: ENTERED,
  lastAccessedAt: ENTERED,
};
const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 7,
  url: `u/${over.number ?? 7}`,
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass',
  headSha: 'aaa',
  ...over,
});
const merged3592 = pr({ number: 3592, url: 'u/3592', state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headSha: 'webhook' });
const open3600 = pr({ number: 3600, url: 'u/3600', reviewDecision: 'REVIEW_REQUIRED', headSha: 'probe' });
const other = (name: string, over: Partial<OtherBranchState> = {}): OtherBranchState => ({
  name,
  exists: true,
  sha: 'tip',
  pushed: true,
  commits: 1,
  unpushed: 0,
  merged: false,
  pr: null,
  ...over,
});
const repo = (
  branch: string,
  p: ShipPr | null,
  others: OtherBranchState[],
  done = false,
  extra: Partial<RepoShipState> = {},
): RepoShipState =>
  ({
    name: 'api',
    path: '/wt/api',
    branch,
    pr: p,
    done,
    mergeBlockers: [],
    localSha: p?.headSha ?? 'tip',
    otherBranches: others,
    ...extra,
  }) as RepoShipState;

function harness(pre: ShipPreflight) {
  const deps = {
    sessions: () => [{ id: 's1', session }],
    preflight: vi.fn(async () => pre),
    archive: vi.fn(async () => {}),
    tell: vi.fn(async () => {}),
    broadcast: vi.fn(),
    options: () => ({ autoArchive: true, fixCi: true, reviewComments: false }),
    told: () => ({ has: () => false, add: () => {} }),
    now: () => LATER,
  } satisfies PrWatchDeps;
  return { deps, watch: createPrWatch(deps) };
}

describe('the PR watch across branches', () => {
  it('old branch merged, new branch open: the stage shows the open PR, the merged one folds under it', async () => {
    // Checked out: the new branch with its open PR; the session's own branch merged (#3592).
    const h = harness({ repos: [repo('fix/probe', open3600, [other('feat/webhooks', { pr: merged3592, merged: true, sha: 'webhook' })])] });
    const ci = await h.watch.refresh('s1');
    expect(ci?.repos[0]).toMatchObject({ branch: 'fix/probe', otherPrs: [{ branch: 'feat/webhooks', pr: { number: 3592 } }] });
    const stage = prStageWire(ci, () => false)!;
    expect(stage.kind).toBe('in_review');
    expect(stage.prs.map((p) => p.number)).toEqual([3600]); // the merged one isn't a pill once an open one is there
    expect(stageRepos(ci!.repos)[0].earlier.map((e) => e.pr.number)).toEqual([3592]);
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('the newest open PR wins even when the checked-out branch has none (Claude switched back to an old branch)', () => {
    const ci = {
      repos: [{ name: 'api', branch: 'feat/webhooks', pr: merged3592, otherPrs: [{ branch: 'fix/probe', pr: open3600 }] }],
    };
    expect(prStageOf(stageRepos(ci.repos))?.prs.map((p) => p.number)).toEqual([3600]);
    // No open PR anywhere: the checked-out branch's (merged) is the stage.
    expect(
      prStageOf(stageRepos([{ name: 'api', pr: merged3592, otherPrs: [{ branch: 'x', pr: pr({ number: 1, state: 'CLOSED' }) }] }]))?.kind,
    ).toBe('merged');
  });

  it("not archived while another branch has commits not pushed — the user's case", async () => {
    // Checked out: the start branch, its PR merged at its tip (done) — but fix/probe has a commit never pushed.
    const pre = {
      repos: [repo('feat/webhooks', merged3592, [other('fix/probe', { pushed: false, unpushed: 1 })], true, { localSha: 'webhook' })],
    };
    const h = harness(pre);
    await h.watch.refresh('s1');
    expect(h.deps.archive).not.toHaveBeenCalled();
    expect(autoArchiveVerdict(pre, session, LATER)).toEqual({
      archive: false,
      why: 'work on other branches: api: fix/probe — 1 commit not pushed',
    });
  });

  it('not archived while another branch has a PR open; archived once everything is merged', async () => {
    const open = { repos: [repo('feat/webhooks', merged3592, [other('fix/probe', { pr: open3600 })], true, { localSha: 'webhook' })] };
    expect(autoArchiveVerdict(open, session, LATER)).toMatchObject({ archive: false, why: expect.stringContaining('PR #3600 open') });
    const h = harness(open);
    await h.watch.refresh('s1');
    expect(h.deps.archive).not.toHaveBeenCalled();
    const allMerged = {
      repos: [
        repo(
          'feat/webhooks',
          merged3592,
          [other('fix/probe', { pr: { ...open3600, state: 'MERGED' }, merged: true, sha: 'probe' })],
          true,
          {
            localSha: 'webhook',
          },
        ),
      ],
    };
    expect(autoArchiveVerdict(allMerged, session, LATER)).toEqual({ archive: true });
  });

  it("a branch whose PR merged at its tip leaves nothing behind, even with origin's copy deleted", () => {
    const pre = {
      repos: [repo('main', null, [other('fix/probe', { pushed: false, unpushed: 3, pr: { ...open3600, state: 'MERGED' }, sha: 'probe' })])],
    };
    expect(workElsewhere(pre)).toEqual([]);
    // Unknown: a host that couldn't say about a pushed branch holds it.
    expect(workElsewhere({ repos: [repo('main', null, [other('fix/x', { ghError: 'gh: offline' })])] })).toEqual([
      'api: fix/x — its PR unknown (gh: offline)',
    ]);
  });

  it('otherPrsOf: newest first; branches with no PR left out', () => {
    expect(
      otherPrsOf(repo('x', null, [other('a', { pr: pr({ number: 3 }) }), other('b'), other('c', { pr: pr({ number: 9 }) })])).map(
        (o) => o.branch,
      ),
    ).toEqual(['c', 'a']);
  });
});

describe('watchBranchOptions (what work web wires into the preflight)', () => {
  const rec: SessionBranches = {
    branches: [
      { repo: 'api', name: 'feat/x', firstSeen: ENTERED, lastSeen: ENTERED, pushed: true },
      { repo: 'api', name: 'fix/y', firstSeen: ENTERED, lastSeen: ENTERED },
      { repo: 'api', name: 'fix/old', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
    ],
  };
  it('recent branches only; asks the host for a branch pushed now, pushed once, or one whose PR it knows; never a resting host', () => {
    const o = watchBranchOptions(
      rec,
      LATER,
      (h) => h === 'azure',
      (_r, b) => b === 'fix/y',
    );
    expect(o.branches({ name: 'api', path: '/wt' }, 'feat/x')).toEqual(['fix/y']);
    expect(o.branches({ name: 'api', path: '/wt' }, 'main').sort()).toEqual(['feat/x', 'fix/y']);
    expect(o.askBranch({ name: 'api' }, { name: 'feat/x', pushed: false })).toBe(true); // pushed once
    expect(o.askBranch({ name: 'api' }, { name: 'fix/y', pushed: false })).toBe(true); // a PR it knows
    expect(o.askBranch({ name: 'api' }, { name: 'fix/z', pushed: false })).toBe(false);
    expect(o.askBranch({ name: 'api', host: 'azure' }, { name: 'feat/x', pushed: true })).toBe(false);
  });
  it('branchFactsOf: what to keep in the record', () => {
    expect(branchFactsOf({ repos: [repo('main', null, [other('a', { exists: false, merged: true })])] })).toEqual([
      { repo: 'api', name: 'a', exists: false, merged: true, pushed: true },
    ]);
  });
});
