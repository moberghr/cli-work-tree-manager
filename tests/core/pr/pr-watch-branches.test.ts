import { describe, it, expect, vi } from 'vitest';
import { autoArchiveVerdict, createPrWatch, type PrWatchDeps } from '../../../src/core/pr/pr-watch.js';
import { otherPrsOf, stageInputOf, workElsewhere } from '../../../src/core/pr/branch-work.js';
import { prStageOf, stageRepos } from '../../../src/core/pr/pr-stage.js';
import { prStageWire } from '../../../src/core/sessions/session-wire.js';
import { branchFactsOf, watchBranchOptions, watchPreflight, withListedPrs, type ListedPrsIo } from '../../../src/core/pr/pr-watch-hosts.js';
import { noteSessionPrs, readSessionPrs, type SessionPrRecord, type SessionPrs } from '../../../src/core/pr/session-prs.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
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

  it("two open PRs from two branches of one repo both show — the user's case (#3656 and #3657, #3592 merged)", async () => {
    const open3656 = pr({ number: 3656, url: 'u/3656', reviewDecision: 'REVIEW_REQUIRED', headSha: 'probe' });
    const open3657 = pr({ number: 3657, url: 'u/3657', checks: 'fail', headSha: 'culture' });
    const h = harness({
      repos: [
        repo('fix/probe', open3656, [
          other('fix/culture', { pr: open3657, sha: 'culture' }),
          other('feat/webhooks', { pr: merged3592, merged: true, sha: 'webhook' }),
        ]),
      ],
    });
    const ci = await h.watch.refresh('s1');
    const stage = prStageWire(ci, () => false)!;
    expect(stage.prs.map((p) => p.number)).toEqual([3657, 3656]);
    expect(stage.kind).toBe('checks_failing'); // the most pressing of them
    const [api] = stageRepos(ci!.repos);
    expect(api.also.map((a) => a.pr.number)).toEqual([3656]);
    expect(api.earlier.map((e) => e.pr.number)).toEqual([3592]); // only merged and closed ones fold
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
      { repo: 'api', name: 'a', exists: false, merged: true, pushed: true, sha: 'tip' },
    ]);
  });
});

describe("every PR the session owns: other branches', listed ones, other repos' (session-prs.ts)", () => {
  const open3656 = pr({ number: 3656, url: 'u/3656', headSha: 'probe', reviewDecision: 'REVIEW_REQUIRED' });
  const failing3657 = pr({ number: 3657, url: 'u/3657', headSha: 'culture', checks: 'fail', failing: [{ name: 'Test' }] });

  it("#3657's failing CI on a branch that isn't checked out is asked of its Claude, naming the branch and how to get there", async () => {
    const h = harness({ repos: [repo('fix/probe', open3656, [other('fix/culture', { pr: failing3657, sha: 'culture' })])] });
    await h.watch.tick();
    const body = (h.deps.tell.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]).join('\n');
    expect(body).toContain('PR #3657 on fix/culture (not checked out: fix/probe is): Test');
    expect(body).toContain('`git switch <its branch>`');
    expect(body).toContain('run it again instead'); // a check failing outside the code needs no change
  });

  it('the checked-out branch needs no word about where it is', async () => {
    const h = harness({ repos: [repo('fix/culture', failing3657, [])] });
    await h.watch.tick();
    const body = (h.deps.tell.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]).join('\n');
    expect(body).toContain('- PR #3657: Test');
    expect(body).not.toContain('git switch');
  });

  it("a listed PR in a repo the session doesn't have: on the check, in the stage, its failing CI asked about", async () => {
    const docs = pr({ number: 87, url: 'u/87', checks: 'fail', failing: [{ name: 'Build' }] });
    const h = harness({ repos: [repo('fix/probe', open3656, [])], elsewhere: [{ repo: 'kvika/docs', pr: docs, branch: 'docs/webhooks' }] });
    const ci = await h.watch.refresh('s1');
    expect(ci?.elsewhere).toEqual([{ repo: 'kvika/docs', pr: docs, branch: 'docs/webhooks' }]);
    expect(prStageWire(ci, () => false)?.prs.map((p) => [p.repo, p.number])).toEqual([
      ['api', 3656], // the session's own repos first
      ['kvika/docs', 87],
    ]);
    const body = (h.deps.tell.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]).join('\n');
    expect(body).toContain("PR #87 (kvika/docs) (not one of this session's repos; branch docs/webhooks): Build");
    expect(body).toContain('work in your checkout of that repo');
  });

  it('someone else’s PR on another branch is only shown: its CI isn’t asked of Claude', async () => {
    const theirs = pr({ number: 3657, url: 'u/3657', author: 'dana', checks: 'fail', failing: [{ name: 'Test' }] });
    const h = harness({ repos: [repo('fix/probe', pr({ ...open3656, author: 'me' }), [other('fix/culture', { pr: theirs })])] });
    (h.deps as PrWatchDeps).viewer = async () => 'me';
    const watch = createPrWatch(h.deps);
    await watch.tick();
    expect(h.deps.tell).not.toHaveBeenCalled();
  });

  it('a listed PR still open keeps the session; one the host could not be asked about too', () => {
    expect(workElsewhere({ repos: [repo('main', null, [], true, { listedPrs: [{ branch: 'fix/x', pr: open3656 }] })] })).toEqual([
      'api: PR #3656 open (fix/x)',
    ]);
    expect(workElsewhere({ repos: [], elsewhere: [{ repo: 'kvika/docs', pr: open3656 }] })).toEqual(['kvika/docs: PR #3656 open']);
    expect(workElsewhere({ repos: [], unknownPrs: ['api#3644: HTTP 502'] })).toEqual(['api#3644: HTTP 502 (its state unknown)']);
  });

  it('the stage reads repos outside the session as repos of their own, newest PR first', () => {
    const a = pr({ number: 80, url: 'u/80', state: 'MERGED' });
    const b = pr({ number: 87, url: 'u/87' });
    const input = stageInputOf({
      repos: [],
      elsewhere: [
        { repo: 'kvika/docs', pr: a },
        { repo: 'kvika/docs', pr: b, branch: 'd' },
      ],
    });
    expect(input).toEqual([{ name: 'kvika/docs', pr: b, branch: 'd', done: false, elsewhere: true, otherPrs: [{ branch: '', pr: a }] }]);
  });
});

describe("the watch's preflight with the session's PR list (watchPreflight, withListedPrs)", () => {
  const listed = (prs: Array<Partial<SessionPrRecord> & { url: string; number: number }>): SessionPrs => ({
    prs: prs.map((p) => ({ repoId: 'kvika/straumur-backend', sources: ['agent'], firstSeen: '2026-11-01T00:00:00Z', ...p })),
  });
  const io = (over: Partial<ListedPrsIo> = {}): ListedPrsIo => ({
    repoIdOf: () => 'kvika/straumur-backend',
    hostOfUrl: () => undefined,
    lookup: vi.fn(async (_cwd, _host, ref) => ({
      kind: 'pr' as const,
      pr: pr({ number: ref.number, url: ref.url, headBranch: 'fix/nullable' }),
    })),
    ...over,
  });
  const backend = (p: ShipPr | null = null, others: OtherBranchState[] = []) => ({ ...repo('fix/probe', p, others), path: '/wt/backend' });

  it('#3644, on a branch never recorded, is looked up by its link and put on its repo; found ones are not asked again', async () => {
    const lookups = io();
    const out = await withListedPrs(
      { repos: [backend(open3600)] },
      listed([
        { url: 'u/3600', number: 3600 },
        { url: 'https://github.com/kvika/straumur-backend/pull/3644', number: 3644 },
      ]),
      lookups,
    );
    expect(out.pre.repos[0].listedPrs).toEqual([{ branch: 'fix/nullable', pr: expect.objectContaining({ number: 3644 }) }]);
    expect(lookups.lookup).toHaveBeenCalledTimes(1); // #3600 came with the branch
    expect(lookups.lookup).toHaveBeenCalledWith('/wt/backend', undefined, {
      number: 3644,
      url: 'https://github.com/kvika/straumur-backend/pull/3644',
    });
    expect(out.sightings).toEqual([{ url: 'u/3600', number: 3600, branch: 'fix/probe', source: 'branch' }]);
    expect(out.looks.map((l) => l.pr.number)).toEqual([3644]);
  });

  it("a repo the session doesn't have: in elsewhere, asked in a neutral folder", async () => {
    const lookups = io({ repoIdOf: () => 'kvika/straumur-backend' });
    const out = await withListedPrs(
      { repos: [backend()] },
      listed([{ url: 'https://github.com/kvika/docs/pull/87', number: 87, repoId: 'kvika/docs' }]),
      lookups,
    );
    expect(out.pre.elsewhere).toEqual([{ repo: 'kvika/docs', branch: 'fix/nullable', pr: expect.objectContaining({ number: 87 }) }]);
    expect(lookups.lookup).toHaveBeenCalledWith(undefined, undefined, expect.anything());
  });

  it('a finished PR is its last look, never asked; a host that rests or fails keeps the last check, else it is unknown', async () => {
    const merged = pr({ number: 3592, url: 'u/3592', state: 'MERGED' });
    const lookups = io({
      lookup: vi.fn(async () => ({ kind: 'error' as const, error: 'HTTP 502' })),
      previous: (u) => (u === 'u/2' ? pr({ number: 2, url: 'u/2' }) : undefined),
    });
    const out = await withListedPrs(
      { repos: [backend()] },
      listed([
        { url: 'u/3592', number: 3592, final: merged },
        { url: 'u/2', number: 2 },
        { url: 'u/3', number: 3 },
      ]),
      lookups,
    );
    expect(out.pre.repos[0].listedPrs?.map((l) => l.pr.number)).toEqual([3592, 2]);
    expect(out.pre.unknownPrs).toEqual(['api#3: HTTP 502']);
    expect(lookups.lookup).toHaveBeenCalledTimes(2);
    const resting = io({ resting: () => true });
    await withListedPrs({ repos: [backend()] }, listed([{ url: 'u/4', number: 4 }]), resting);
    expect(resting.lookup).not.toHaveBeenCalled();
  });

  it('watchPreflight: the list read and written, the required-checks list applied to the listed PRs', async () => {
    const s = { ...session, target: 'api', branch: 'feat/webhooks-wp' };
    const id = sessionIdFor(s);
    noteSessionPrs(id, [{ url: 'https://github.com/kvika/straumur-backend/pull/3644', number: 3644, source: 'agent' }]);
    const failingLook = io({
      lookup: async (_c, _h, ref) => ({
        kind: 'pr',
        pr: pr({ number: ref.number, url: ref.url, checks: 'fail', failing: [{ name: 'OWASP' }], state: 'CLOSED' }),
      }),
    });
    const pre = await watchPreflight(
      s,
      async () => ({ code: 0, stdout: '', stderr: '' }),
      { requiredChecks: { api: ['Test'] } },
      { preflight: async () => ({ repos: [backend(open3600)] }), listed: failingLook },
    );
    expect(pre.repos[0].listedPrs?.[0].pr).toMatchObject({ number: 3644, checks: 'pass', optionalFailing: [{ name: 'OWASP' }] });
    const rec = readSessionPrs(id);
    expect(rec?.prs.map((p) => [p.number, p.sources])).toEqual([
      [3644, ['agent']],
      [3600, ['branch']],
    ]);
    expect(rec?.prs[0].final?.state).toBe('CLOSED'); // closed: asked no more
  });
});
