import { describe, it, expect, vi } from 'vitest';
import { autoArchiveVerdict, createPrWatch, ciFixMessage, type PrWatchDeps } from '../../src/core/pr-watch.js';
import { createActivityLog } from '../../src/core/activity.js';
import type { RepoShipState, ShipPr, ShipPreflight } from '../../src/core/api-types.js';
import type { WorktreeSession } from '../../src/core/session-types.js';
import type { ReviewFeedback } from '../../src/core/pr-review.js';

/** Entered at 09:00; merges in these tests happen at 10:00 unless said otherwise. */
const ENTERED = '2026-09-30T09:00:00Z';
const session = (isGroup = false): WorktreeSession => ({
  target: isGroup ? 'shop' : 'api', branch: 'feat/x', isGroup, paths: [], createdAt: ENTERED, lastAccessedAt: ENTERED,
});
const merged = (mergedAt: string | undefined = '2026-09-30T10:00:00Z') => pr({ state: 'MERGED', mergedAt });
const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 7, url: 'u', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'aaa', ...over,
});
const repo = (name: string, p: ShipPr | null, done = false): RepoShipState =>
  ({ name, path: `/wt/${name}`, pr: p, done, mergeBlockers: [] } as unknown as RepoShipState);

const ON = { autoArchive: true, fixCi: true, reviewComments: true };
/** "Now" for the watch: two days after ENTERED, unless a test says otherwise. */
const LATER = Date.parse(ENTERED) + 48 * 3600_000;
function harness(repos: RepoShipState[], opts: ReturnType<PrWatchDeps['options']> = ON, isGroup = false, feedback: ReviewFeedback | null = null, extra: Partial<PrWatchDeps> = {}) {
  let pre: ShipPreflight = { repos };
  const told = new Set<string>();
  const deps = {
    sessions: () => [{ id: 's1', session: session(isGroup) }],
    preflight: vi.fn(async () => pre),
    archive: vi.fn(async () => {}),
    tell: vi.fn(async () => {}),
    broadcast: vi.fn(),
    options: () => opts,
    told: () => ({ has: (k: string) => told.has(k), add: (k: string) => void told.add(k) }),
    reviewFeedback: vi.fn(async () => feedback),
    now: () => LATER,
  } satisfies PrWatchDeps;
  Object.assign(deps, extra); // tests also change deps later: the watch must see the same object
  return { deps, watch: createPrWatch(deps), set: (r: RepoShipState[]) => (pre = { repos: r }) };
}
/** A note's first words, before any "(…)" or ":" */
const heading = (m: string) => m.split('\n')[0].split(/ \(|:/)[0];
const failing = (sha = 'aaa') => pr({ checks: 'fail', headSha: sha, failing: [{ name: 'test' }, { name: 'lint' }] });

describe('PR watch', () => {
  it('tells Claude once per failing head commit, and again after a push that fails too', async () => {
    const h = harness([repo('api', failing())]);
    await h.watch.tick();
    await h.watch.tick();
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    expect(h.deps.tell.mock.calls[0][1]).toContain('PR #7: test, lint');
    expect(h.deps.tell.mock.calls[0][1]).toContain('DECISION NEEDED: <the question>');

    h.set([repo('api', failing('bbb'))]);
    await h.watch.tick();
    expect(h.deps.tell).toHaveBeenCalledTimes(2);
  });

  it('with fixCi off, it only watches', async () => {
    const h = harness([repo('api', failing())], { ...ON, fixCi: false });
    await h.watch.tick();
    expect(h.deps.tell).not.toHaveBeenCalled();
    expect(h.watch.state('s1')?.repos[0].pr?.checks).toBe('fail');
  });

  it('archives once every repo is done and something merged', async () => {
    const h = harness([repo('api', merged(), true)]);
    await h.watch.tick();
    expect(h.deps.archive).toHaveBeenCalledWith('s1');
  });

  it('a report-only refresh (the GET) posts no notes and archives nothing', async () => {
    const h = harness([repo('api', merged(), true)]);
    const h2 = harness([repo('api', failing())]);
    await h.watch.refresh('s1', { act: false });
    await h2.watch.refresh('s1', { act: false });
    expect(h.deps.archive).not.toHaveBeenCalled();
    expect(h2.deps.tell).not.toHaveBeenCalled();
    expect(h2.watch.state('s1')?.repos[0].pr?.checks).toBe('fail'); // still reported
  });

  it('never archives for a merge from before you entered the session', async () => {
    // `work tree` on a branch name whose old PR merged last week (gh reports
    // that PR), or re-entering an archived session on purpose.
    const h = harness([repo('api', merged('2026-09-23T10:00:00Z'), true)]);
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('archives a merge from before you re-entered when the merged PR is exactly the checked-out work, after a quiet day', async () => {
    // You opened the session again after its PR was merged, to look, then left it.
    const h = harness([{ ...repo('api', merged('2026-09-30T08:00:00Z'), true), localSha: 'aaa', dirtyFiles: 0 } as RepoShipState]);
    await h.watch.tick();
    expect(h.deps.archive).toHaveBeenCalledWith('s1');
  });

  it('re-entered on purpose (Restore, or work tree at the merged tip): not archived again that day', async () => {
    const h = harness([{ ...repo('api', merged('2026-09-30T08:00:00Z'), true), localSha: 'aaa', dirtyFiles: 0 } as RepoShipState], ON, false, null,
      { now: () => Date.parse(ENTERED) + 3600_000 });
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it("GitHub's rate limit: keeps what it knew, acts on nothing, and rests its sweeps", async () => {
    let t = LATER;
    const h = harness([{ ...repo('api', pr({ state: 'OPEN' })), openThreads: 0 } as RepoShipState], ON, false, {
      viewer: 'me', reviews: [], comments: [],
      threads: [{ id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: [{ id: 'c1', author: 'rev', association: 'MEMBER', body: 'fix', url: 'u', at: ENTERED }] }],
    } as unknown as ReviewFeedback, { now: () => t });
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1);

    // Now every gh call says the limit is spent: the PR reads as none.
    h.set([{ ...repo('api', null, true), ghError: 'GraphQL: API rate limit already exceeded for user ID 1.' } as RepoShipState]);
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0]).toMatchObject({ pr: { number: 7 }, openThreads: 1 }); // not "no PR"
    expect(h.deps.archive).not.toHaveBeenCalled();
    const calls = h.deps.preflight.mock.calls.length;
    t += 60_000;
    await h.watch.tick(); // resting: no gh at all
    expect(h.deps.preflight.mock.calls.length).toBe(calls);
    t += 10 * 60_000;
    await h.watch.tick();
    expect(h.deps.preflight.mock.calls.length).toBe(calls + 1);
  });

  it('a review lookup that fails keeps the last count for the same PR', async () => {
    const feedback = vi.fn<() => Promise<ReviewFeedback | null>>(async () => ({
      viewer: 'me', reviews: [], comments: [],
      threads: [{ id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: [{ id: 'c1', author: 'rev', association: 'MEMBER', body: 'fix', url: 'u', at: ENTERED }] }],
    } as unknown as ReviewFeedback));
    const h = harness([repo('api', pr({ state: 'OPEN' }))], ON, false, null, { reviewFeedback: feedback });
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1);
    feedback.mockResolvedValue(null);
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1);
  });

  describe('GitHub calls', () => {
    it("re-reads a PR's review threads only when the PR changed (its updatedAt)", async () => {
      const fbOf = { viewer: 'me', reviews: [], comments: [], threads: [] } as unknown as ReviewFeedback;
      const h = harness([repo('api', pr({ updatedAt: '2026-09-30T10:00:00Z' }))], ON, false, fbOf);
      await h.watch.tick();
      await h.watch.tick();
      expect(h.deps.reviewFeedback).toHaveBeenCalledTimes(1);
      h.set([repo('api', pr({ updatedAt: '2026-09-30T11:00:00Z' }))]);
      await h.watch.tick();
      expect(h.deps.reviewFeedback).toHaveBeenCalledTimes(2);
    });

    it('a refresh while a check runs joins it instead of starting another', async () => {
      let release!: () => void;
      const h = harness([repo('api', pr())]);
      h.deps.preflight.mockImplementationOnce(() => new Promise((r) => (release = () => r({ repos: [repo('api', pr())] }))));
      const sweep = h.watch.tick();
      await new Promise((r) => setTimeout(r, 0));
      const refresh = h.watch.refresh('s1');
      release();
      await Promise.all([sweep, refresh]);
      expect(h.deps.preflight).toHaveBeenCalledTimes(1);
    });
  });

  describe('feedback for a Claude that is not running', () => {
    const botThread = {
      viewer: 'me', reviews: [], comments: [],
      threads: [{ id: 'PRRT_t1', isResolved: false, isOutdated: false, path: 'a.ts', line: 3, comments: [{ id: 'c1', author: 'copilot-pull-request-reviewer', association: 'NONE', body: 'use a const', url: 'u1', createdAt: ENTERED }] }],
    } as unknown as ReviewFeedback;

    it("hands a trusted bot's thread over, records it for the reply drafts, and starts the Claude", async () => {
      const activity = createActivityLog();
      const wake = vi.fn(async () => 'started' as const);
      const rememberThreads = vi.fn();
      const h = harness([repo('api', pr())], ON, false, botThread, { wake, rememberThreads, activity });
      await h.watch.tick();
      expect(h.deps.tell).toHaveBeenCalledTimes(1);
      expect(h.deps.tell.mock.calls[0][1]).toContain('[thread PRRT_t1]');
      expect(rememberThreads).toHaveBeenCalledWith('s1', [expect.objectContaining({ threadId: 'PRRT_t1', repo: 'api', prNumber: 7, reviewer: 'copilot-pull-request-reviewer', where: 'a.ts:3' })]);
      expect(wake).toHaveBeenCalledWith('s1');
      expect(activity.snapshot().recent[0].notes[0].text).toContain('(started it: it resumes its conversation and works on it now)');
    });

    it("the note carries the sub-agent hint when the session's conversation is filling up", async () => {
      const h = harness([repo('api', pr())], ON, false, botThread, { contextShare: () => 0.82 });
      await h.watch.tick();
      expect(h.deps.tell.mock.calls[0][1]).toContain('This conversation is 82% full');
    });

    it('trustedBots: [] turns bots off', async () => {
      const h = harness([repo('api', pr())], { ...ON, trustedBots: [] }, false, botThread);
      await h.watch.tick();
      expect(h.deps.tell).not.toHaveBeenCalled();
    });

    it('a note that could not be delivered wakes nothing', async () => {
      const wake = vi.fn(async () => 'started' as const);
      const h = harness([repo('api', pr())], ON, false, botThread, { wake });
      h.deps.tell.mockRejectedValueOnce(new Error('down'));
      await h.watch.tick();
      expect(wake).not.toHaveBeenCalled();
    });
  });

  describe('what it tells the Activity panel', () => {
    it('one run per sweep, with progress, a note per decision, and a summary', async () => {
      const activity = createActivityLog();
      const h = harness([repo('api', failing())], ON, false, null, { activity });
      await h.watch.tick();
      const [run] = activity.snapshot().recent;
      expect(run).toMatchObject({ kind: 'pr-watch', status: 'done', progress: { done: 1, total: 1 }, summary: '1 session · 1 open PR · 1 failing' });
      expect(run.notes).toEqual([
        expect.objectContaining({ level: 'action', sessionId: 's1', text: 'api feat/x: checks fail on #7 (test, lint): asked its Claude to fix them' }),
      ]);
    });

    it('says why a merged session was kept, and when one is archived', async () => {
      const activity = createActivityLog();
      const kept = harness([{ ...repo('api', merged(), true), localSha: 'aaa', dirtyFiles: 2 } as RepoShipState], ON, false, null, { activity });
      await kept.watch.tick();
      // Uncommitted files no longer keep it: the archive saves them for Restore, and says so.
      expect(activity.snapshot().recent[0].notes[0]).toMatchObject({ level: 'action', text: 'api feat/x: archived: every PR merged; 2 uncommitted files saved, put back on Restore (the conversation is kept)' });
      const ahead = harness([{ ...repo('api', merged(), false), localSha: 'aaa', ahead: 1 } as RepoShipState], ON, false, null, { activity });
      await ahead.watch.tick();
      expect(activity.snapshot().recent[0].notes[0].text).toBe('api feat/x: a PR is merged, but kept: api: PR merged, but 1 unpushed commit');
      const gone = harness([{ ...repo('api', merged(), true), localSha: 'aaa', dirtyFiles: 0 } as RepoShipState], ON, false, null, { activity });
      await gone.watch.tick();
      expect(activity.snapshot().recent[0].notes[0]).toMatchObject({ level: 'action', text: expect.stringContaining('archived: every PR merged') });
    });

    it('GitHub’s limit: a warning, the schedule rests, and the skipped sweeps collapse into one row', async () => {
      let t = LATER;
      const activity = createActivityLog({ now: () => t });
      const h = harness([{ ...repo('api', null, true), ghError: 'API rate limit already exceeded' } as RepoShipState], ON, false, null, { activity, now: () => t });
      h.watch.start(180_000, 60_000)();
      await h.watch.tick();
      expect(activity.snapshot().recent[0].notes[0].level).toBe('warn');
      expect(activity.snapshot().schedules[0]).toMatchObject({ kind: 'pr-watch', pausedWhy: "GitHub's API limit is spent" });
      t += 60_000;
      await h.watch.tick();
      await h.watch.tick();
      expect(activity.snapshot().recent[0]).toMatchObject({ status: 'skipped', repeats: 1 });
    });
  });

  it('autoArchiveVerdict gives the reason it keeps a merged session', () => {
    const pre = (over: Partial<RepoShipState>[]) => ({ repos: over.map((o, i) => ({ ...repo(`r${i}`, merged(), true), localSha: 'aaa', dirtyFiles: 0, ...o }) as RepoShipState) });
    const s = { lastAccessedAt: ENTERED };
    expect(autoArchiveVerdict({ repos: [repo('api', pr())] }, s, LATER)).toBeNull(); // nothing merged
    expect(autoArchiveVerdict(pre([{}, { done: false, pr: pr() } as Partial<RepoShipState>]), s, LATER)).toEqual({ archive: false, why: 'not all merged yet (r1)' });
    expect(autoArchiveVerdict(pre([{ pr: merged('2026-09-30T08:00:00Z') }]), s, Date.parse(ENTERED) + 3600_000)).toMatchObject({ archive: false, why: expect.stringContaining('left alone for a day') });
    expect(autoArchiveVerdict(pre([{ pr: merged('2026-09-30T08:00:00Z'), localSha: 'new' }]), s, LATER)).toMatchObject({ archive: false, why: expect.stringContaining('older work') });
    expect(autoArchiveVerdict(pre([{}]), s, LATER)).toEqual({ archive: true });
  });

  it('merged at the checked-out commit with files left uncommitted: archived (they are saved); commits beyond the merge say what (reported)', () => {
    // fix/pdf-generation-speed: PR merged at the checked-out commit, three files left uncommitted.
    const repoState = { ...repo('straumur-backend', merged(), false), localSha: 'aaa', dirtyFiles: 3 } as RepoShipState;
    repoState.pr = { ...repoState.pr!, headSha: 'aaa' };
    expect(autoArchiveVerdict({ repos: [repoState] }, { lastAccessedAt: ENTERED }, LATER)).toEqual({ archive: true });
    const other = { ...repoState, localSha: 'bbb' } as RepoShipState;
    expect(autoArchiveVerdict({ repos: [other] }, { lastAccessedAt: ENTERED }, LATER)).toMatchObject({ why: expect.stringContaining('a commit checked out that the PR didn’t merge') });
    const ahead = { ...repoState, dirtyFiles: 0, ahead: 2 } as RepoShipState;
    expect(autoArchiveVerdict({ repos: [ahead] }, { lastAccessedAt: ENTERED }, LATER)).toMatchObject({ why: 'straumur-backend: PR merged, but 2 unpushed commits' });
  });

  it('merged work isn’t held up by replies to post or notes for Claude: archived, and the note says what was kept (reported)', async () => {
    const activity = createActivityLog();
    const h = harness([repo('api', merged(), true)], ON, false, null, { waiting: () => ['2 replies to post on review threads'], activity });
    h.deps.archive = vi.fn(async () => '2 reply drafts');
    await h.watch.tick();
    expect(h.deps.archive).toHaveBeenCalled();
    expect(activity.snapshot().recent[0].notes[0].text).toBe('api feat/x: archived: every PR merged; 2 reply drafts kept for Restore (the conversation is kept)');
  });

  it('never archives while its Claude is in the middle of a turn', async () => {
    const activity = createActivityLog();
    const h = harness([repo('api', merged(), true)], ON, false, null, { busy: () => true, activity });
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
    expect(activity.snapshot().recent[0].notes[0].text).toContain('archiving once its Claude finishes this turn');
  });

  it('a reused branch name: an old merged PR with another head never archives the new work', async () => {
    const h = harness([{ ...repo('api', merged('2026-09-30T08:00:00Z'), true), localSha: 'new-work', dirtyFiles: 0 } as RepoShipState]);
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('uncommitted files don’t keep it from auto-archiving (the archive saves them); unpushed commits do', async () => {
    const h = harness([{ ...repo('api', merged(), false), localSha: 'aaa', dirtyFiles: 2 } as RepoShipState]);
    await h.watch.tick();
    expect(h.deps.archive).toHaveBeenCalled();
    const ahead = harness([{ ...repo('api', merged(), false), localSha: 'aaa', ahead: 1 } as RepoShipState]);
    await ahead.watch.tick();
    expect(ahead.deps.archive).not.toHaveBeenCalled();
  });

  it('does not archive when gh gives no merge time', async () => {
    const h = harness([repo('api', pr({ state: 'MERGED' }), true)]);
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('a group merged only in part stays open', async () => {
    const h = harness([repo('backend', merged(), true), repo('frontend', pr(), false)], undefined, true);
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
    // …and untouched repos count as done, but nothing merged means no archive.
    const h2 = harness([repo('a', null, true), repo('b', null, true)], undefined, true);
    await h2.watch.tick();
    expect(h2.deps.archive).not.toHaveBeenCalled();
  });

  it('respects autoArchive off', async () => {
    const h = harness([repo('api', merged(), true)], { ...ON, autoArchive: false });
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('broadcasts ci-changed only when something changed', async () => {
    const h = harness([repo('api', pr({ checks: 'pending' }))]);
    await h.watch.tick();
    await h.watch.tick();
    expect(h.deps.broadcast).toHaveBeenCalledTimes(1);
    h.set([repo('api', pr({ checks: 'pass' }))]);
    await h.watch.tick();
    expect(h.deps.broadcast).toHaveBeenCalledTimes(2);
  });

  it('fixNow asks exactly once, even for a failure the sweep has not seen', async () => {
    const h = harness([repo('api', failing())]);
    expect(await h.watch.fixNow('s1')).toBe(true);
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    await h.watch.tick(); // already told for this head
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    h.set([repo('api', pr())]);
    expect(await h.watch.fixNow('s1')).toBe(false);
  });

  it('overlapping sweeps collapse into one', async () => {
    const h = harness([repo('api', pr())]);
    await Promise.all([h.watch.tick(), h.watch.tick()]);
    expect(h.deps.preflight).toHaveBeenCalledTimes(1);
  });

  it('a gh failure keeps the last known state', async () => {
    const h = harness([repo('api', pr({ checks: 'pending' }))]);
    await h.watch.tick();
    h.deps.preflight.mockRejectedValueOnce(new Error('gh down'));
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0].pr?.checks).toBe('pending');
  });

  it('names the repo in a group message', () => {
    expect(ciFixMessage([{ repo: 'backend', number: 3, checks: ['lint'] }], true)).toContain('PR #3 (backend): lint');
    expect(ciFixMessage([{ repo: 'backend', number: 3, checks: ['lint'] }], true, 0.9)).toContain('90% full. Hand the mechanical fixes');
  });

  describe('review feedback', () => {
    const thread = (id: string, author: string, resolved = false) => ({
      id: `T${id}`, isResolved: resolved, isOutdated: false, path: 'src/a.ts', line: 3,
      comments: [{ id, author, association: 'COLLABORATOR', body: `fix ${id}`, url: `u${id}`, createdAt: '' }],
    });
    const fb = (threads: ReviewFeedback['threads']): ReviewFeedback => ({ viewer: 'me', threads, reviews: [], comments: [] });
    const told = (h: ReturnType<typeof harness>) => (h.deps.tell.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]);

    it('hands new review threads to Claude once, and counts open ones for the strip', async () => {
      const h = harness([repo('api', pr())], ON, false, fb([thread('1', 'alice'), thread('2', 'me'), thread('3', 'bob', true)]));
      await h.watch.tick();
      expect(h.deps.reviewFeedback).toHaveBeenCalledWith('/wt/api', 7);
      expect(told(h)).toHaveLength(1);
      expect(told(h)[0]).toContain('src/a.ts:3 — @alice: "fix 1"');
      expect(told(h)[0]).not.toContain('fix 2');
      expect(told(h)[0]).not.toContain('fix 3');
      expect(told(h)[0]).toContain('DECISION NEEDED:');
      expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1);
      await h.watch.tick();
      expect(told(h)).toHaveLength(1);
    });

    it('never hands review text to a session running with permission checks off', async () => {
      const h = harness([repo('api', pr())], ON, false, fb([thread('1', 'alice')]));
      h.deps.sessions = () => [{ id: 's1', session: { ...session(), launchedUnsafe: true } }];
      await h.watch.tick();
      expect(h.deps.tell).not.toHaveBeenCalled();
      expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1); // still counted for the strip

      const host = harness([repo('api', pr())], ON, false, fb([thread('1', 'alice')]));
      (host.deps as PrWatchDeps).runsUnsafe = () => true; // a PTY-host session spawned --unsafe
      const w = createPrWatch(host.deps);
      await w.tick();
      expect(host.deps.tell).not.toHaveBeenCalled();
    });

    it('only looks at open PRs, and not at all when turned off', async () => {
      const merged = harness([repo('api', pr({ state: 'MERGED' }), true)], ON, false, fb([thread('1', 'alice')]));
      await merged.watch.tick();
      expect(merged.deps.reviewFeedback).not.toHaveBeenCalled();
      const off = harness([repo('api', pr())], { ...ON, reviewComments: false }, false, fb([thread('1', 'alice')]));
      await off.watch.tick();
      expect(off.deps.reviewFeedback).not.toHaveBeenCalled();
      expect(off.deps.tell).not.toHaveBeenCalled();
    });

    it('a note that fails to send is retried on the next sweep, then not repeated', async () => {
      const h = harness([repo('api', failing())], ON, false, fb([thread('1', 'alice')]));
      h.deps.tell.mockRejectedValueOnce(new Error('work web restarting')).mockRejectedValueOnce(new Error('again'));
      await h.watch.tick(); // both notes fail
      expect(h.deps.tell).toHaveBeenCalledTimes(2);
      await h.watch.tick(); // both delivered now
      expect(told(h).slice(2).map(heading)).toEqual(['New review feedback on GitHub', 'CI is failing']);
      await h.watch.tick(); // and never again
      expect(h.deps.tell).toHaveBeenCalledTimes(4);
    });

    it('CI failures and review feedback arrive as separate notes', async () => {
      const h = harness([repo('api', failing())], ON, false, fb([thread('1', 'alice')]));
      await h.watch.tick();
      expect(told(h).map(heading)).toEqual(['New review feedback on GitHub', 'CI is failing']);
    });
  });
});
