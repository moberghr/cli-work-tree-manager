import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillSessionBranches,
  branchHidden,
  cleanBranches,
  GONE_SHOWN_MS,
  LAST_SEEN_STEP_MS,
  MAX_WATCHED_BRANCHES,
  noteBranches,
  noteBranchFacts,
  otherBranchesToWatch,
  readSessionBranches,
  recordCheckedOutBranches,
  withSightings,
  type SessionBranches,
} from '../../../src/core/sessions/session-branches.js';
import { branchesFromReflog, checkoutBranchHistory, parseReflogLine, startFromReflog } from '../../../src/core/git/reflog.js';
import { checkedOutBranch, gitDirs } from '../../../src/core/git/git-head.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { purgeSessionRows, tx } from '../../../src/core/platform/db.js';
import { branchFacts, branchJobs, branchesWire, sessionBranchesNow } from '../../../src/core/stacks/branch-facts.js';
import { computeSessionRange, historyBranchRefs, sessionCommits, sessionHistory } from '../../../src/core/diff/session-history.js';
import { shipPreflight, workElsewhere } from '../../../src/core/pr/ship.js';
import { recordBranchesFor, runTurnHook } from '../../../src/commands/hook.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const T0 = new Date('2026-11-01T10:00:00Z');

describe('withSightings (pure)', () => {
  it('appends a new branch, widens a known one, and writes nothing when nothing moved', () => {
    const one = withSightings(null, [{ repo: 'api', name: 'feat/x', from: 'origin/dev' }], T0);
    expect(one.branches).toEqual([
      { repo: 'api', name: 'feat/x', firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), from: 'origin/dev' },
    ]);
    // A minute later: lastSeen moved less than the step, so the same record (no write).
    expect(withSightings(one, [{ repo: 'api', name: 'feat/x' }], new Date(T0.getTime() + 60_000))).toBe(one);
    const later = new Date(T0.getTime() + LAST_SEEN_STEP_MS);
    const two = withSightings(
      one,
      [
        { repo: 'api', name: 'feat/x' },
        { repo: 'api', name: 'fix/y' },
      ],
      later,
    );
    expect(two.branches.map((b) => [b.name, b.lastSeen])).toEqual([
      ['feat/x', later.toISOString()],
      ['fix/y', later.toISOString()],
    ]);
    // A backfill's earlier sighting widens firstSeen; it marks the record backfilled once.
    const back = withSightings(
      two,
      [{ repo: 'api', name: 'feat/x', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-02T00:00:00.000Z' }],
      later,
      {
        backfilled: true,
      },
    );
    expect(back.branches[0].firstSeen).toBe('2026-10-01T00:00:00.000Z');
    expect(back.backfilled).toBe(later.toISOString());
  });

  it('a stored record is shape-checked: bad entries go, the record stays', () => {
    expect(cleanBranches(null)).toBeNull();
    expect(cleanBranches({ branches: 'no' })).toBeNull();
    const rec = cleanBranches({
      branches: [
        { repo: 'api', name: 'a', firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), merged: true, pushed: 'x' },
        { repo: 1 },
        null,
      ],
      backfilled: 'not a date',
    });
    expect(rec).toEqual({ branches: [{ repo: 'api', name: 'a', firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), merged: true }] });
  });

  it('a merged branch deleted a while ago is hidden; one deleted without merging never is', () => {
    const gone = new Date(T0.getTime() - GONE_SHOWN_MS).toISOString();
    expect(branchHidden({ gone, merged: true }, T0.getTime())).toBe(true);
    expect(branchHidden({ gone }, T0.getTime())).toBe(false);
    expect(branchHidden({ gone }, T0.getTime(), true)).toBe(true); // its PR merged
    expect(branchHidden({ gone: T0.toISOString(), merged: true }, T0.getTime())).toBe(false); // just now: still shown
  });

  it('the branches to watch: recent, not the checked-out one, newest first, a few at most', () => {
    const rec: SessionBranches = {
      branches: Array.from({ length: 8 }, (_, i) => ({
        repo: 'api',
        name: `b${i}`,
        firstSeen: T0.toISOString(),
        lastSeen: new Date(T0.getTime() - i * 3600_000).toISOString(),
      })),
    };
    rec.branches.push({ repo: 'web', name: 'other', firstSeen: T0.toISOString(), lastSeen: T0.toISOString() });
    const names = otherBranchesToWatch(rec, 'api', 'b0', T0.getTime(), 30 * 24 * 3600_000);
    expect(names).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'].slice(0, MAX_WATCHED_BRANCHES));
    expect(otherBranchesToWatch(rec, 'api', 'b0', T0.getTime(), 2.5 * 3600_000)).toEqual(['b1', 'b2']);
  });
});

describe("where a branch's own work begins (its reflog, pure)", () => {
  const sha = (c: string) => c.repeat(40);
  const l = (to: string, message: string) => parseReflogLine(`${'0'.repeat(40)} ${sha(to)} T <t@t> 100 +0100\t${message}`)!;

  it("feat/webhook's real reflog: made, fast-forwarded onto dev, a commit, rebased onto newer dev — its work starts there", () => {
    expect(
      startFromReflog([
        l('1', 'branch: Created from HEAD'),
        l('2', 'merge origin/dev: Fast-forward (no commit created; -m option ignored)'),
        l('3', 'commit: feat(SD-3999): webhook delivery log'),
        l('4', `rebase (finish): refs/heads/feat/webhook-improvements onto ${sha('9')}`),
        l('5', 'commit: fix(SD-3999): blank line before comments'),
        l('6', "merge origin/dev: Merge made by the 'ort' strategy."), // its base merged in: no new start
        l('7', 'commit (merge): Merge origin/dev into feat/webhook-improvements'),
      ]),
    ).toBe(sha('9'));
  });

  it('a reset or a pull that fast-forwarded moves it; commits alone never do; nothing known: null', () => {
    expect(startFromReflog([l('1', 'branch: Created from origin/dev'), l('2', 'commit: a')])).toBe(sha('1'));
    expect(startFromReflog([l('1', 'branch: Created from origin/dev'), l('2', 'reset: moving to origin/dev')])).toBe(sha('2'));
    expect(startFromReflog([l('1', 'pull: Fast-forward'), l('2', 'commit: a')])).toBe(sha('1'));
    expect(startFromReflog([l('1', 'commit: a')])).toBeNull();
    expect(startFromReflog([])).toBeNull();
  });
});

describe('reflog parsing (pure)', () => {
  const line = (sec: number, msg: string) => `a b T <t@t> ${sec} +0100\t${msg}`;
  it('reads time and message; branches in the order HEAD came to them, with the one it left', () => {
    expect(parseReflogLine(line(1793784300, 'commit: x'))).toEqual({ at: 1793784300_000, message: 'commit: x' });
    expect(parseReflogLine('garbage')).toBeNull();
    // A real line carries the commit it moved to: a branch's first line is the commit it was made at.
    const old = '0'.repeat(40);
    const at = 'a'.repeat(40);
    expect(parseReflogLine(`${old} ${at} T <t@t> 100 +0100\tbranch: Created from origin/dev`)).toEqual({
      at: 100_000,
      message: 'branch: Created from origin/dev',
      sha: at,
    });
    // A branch deleted (moved to nothing): no commit.
    expect(parseReflogLine(`${at} ${old} T <t@t> 100 +0100\tx`)?.sha).toBeUndefined();
    const lines = [
      line(100, 'commit: on feat'),
      line(200, 'checkout: moving from feat/x to fix/a'),
      line(300, 'commit: on a'),
      line(400, 'checkout: moving from fix/a to 0123456789abcdef'), // detached: no branch
      line(450, 'rebase (finish): returning to refs/heads/fix/a'),
      line(500, 'checkout: moving from fix/a to origin/dev'), // a remote ref: no branch
      line(600, 'checkout: moving from origin/dev to fix/b'),
    ].map((l) => parseReflogLine(l)!);
    const out = branchesFromReflog(lines, { start: 'feat/x', current: 'fix/b' });
    expect(out.map((b) => [b.name, b.firstSeen / 1000, b.lastSeen / 1000, b.movedFrom ?? null])).toEqual([
      ['feat/x', 100, 200, null],
      ['fix/a', 200, 500, 'feat/x'],
      ['fix/b', 600, 600, null],
    ]);
  });
});

// The user's case, as a real repo: a group session (backend + frontend) on feat/webhook-improvements; the backend's
// branch merged into dev, then Claude made fix/SD-3999 from origin/dev and committed, then fix/tests from origin/dev and
// committed (checked out now). Neither pushed, no PRs. Built once (testing.md §4.7); the tests that change it come last.
let tmp: string;
let backend: string;
let frontend: string;
let session: WorktreeSession;
let sdSha: string;

function makeRepo(name: string): { clone: string; wt: string } {
  const origin = path.join(tmp, `${name}.git`);
  const clone = path.join(tmp, name);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, clone);
  fs.writeFileSync(path.join(clone, 'readme.md'), 'hi\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'first');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'push', '-q', 'origin', 'main:dev');
  git(clone, 'fetch', '-q');
  git(clone, 'remote', 'set-head', 'origin', 'dev');
  const wt = path.join(tmp, 'worktrees', 'straumur', 'feat-webhook-improvements', name);
  git(clone, 'worktree', 'add', '-q', '-b', 'feat/webhook-improvements', wt, 'origin/dev');
  return { clone, wt };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branches-'));
  const b = makeRepo('backend');
  const f = makeRepo('frontend');
  backend = b.wt;
  frontend = f.wt;
  // The webhook work: committed, pushed, merged into dev (PR #3592).
  fs.writeFileSync(path.join(backend, 'webhook.cs'), 'class Webhook {}\n');
  git(backend, 'add', '.');
  git(backend, 'commit', '-q', '-m', 'feat(SD-3999): webhook delivery log');
  git(backend, 'push', '-q', 'origin', 'feat/webhook-improvements');
  git(backend, 'push', '-q', 'origin', 'feat/webhook-improvements:dev');
  git(backend, 'fetch', '-q');
  // Moving on: two new branches from origin/dev, one commit each, not pushed.
  git(backend, 'checkout', '-q', '-b', 'fix/SD-3999-probe-recovers-on-2xx', 'origin/dev');
  fs.writeFileSync(path.join(backend, 'probe.cs'), 'class Probe {}\n');
  git(backend, 'add', '.');
  git(backend, 'commit', '-q', '-m', 'fix(SD-3999): webhook recovers only on a 2xx probe');
  sdSha = git(backend, 'rev-parse', 'HEAD');
  git(backend, 'checkout', '-q', '-b', 'fix/tests-deterministic-culture', 'origin/dev');
  fs.writeFileSync(path.join(backend, 'culture.cs'), 'class Culture {}\n');
  git(backend, 'add', '.');
  git(backend, 'commit', '-q', '-m', 'test: run every test project under the invariant culture');
  session = {
    target: 'straumur',
    isGroup: true,
    branch: 'feat/webhook-improvements',
    paths: [backend, frontend],
    repos: ['backend', 'frontend'],
    createdAt: '2026-10-01T00:00:00Z',
    lastAccessedAt: '2026-10-01T00:00:00Z',
  };
}, 120_000); // two repos and a dozen git runs: slow under a full parallel run
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the user's case: a session that moved on to two new branches after its PR merged", () => {
  it('the reflog shows every branch the backend was on, each with what it was made from', () => {
    // The worktree's own folder (HEAD, its reflog) and the repo's shared one (branches' reflogs).
    expect(gitDirs(backend)!.commonDir.split(/[\\/]/).slice(-2)).toEqual(['backend', '.git']);
    expect(gitDirs(backend)!.gitDir.split(/[\\/]/).slice(-3, -1)).toEqual(['.git', 'worktrees']);
    const h = checkoutBranchHistory(backend, session.branch);
    expect(h.map((b) => [b.name, b.from ?? null])).toEqual([
      ['feat/webhook-improvements', 'origin/dev'],
      ['fix/SD-3999-probe-recovers-on-2xx', 'origin/dev'],
      ['fix/tests-deterministic-culture', 'origin/dev'],
    ]);
  });

  it('backfill records them once (and the frontend on its one branch), in state.db', () => {
    const rec = backfillSessionBranches(session, T0);
    expect(rec.backfilled).toBe(T0.toISOString());
    expect(rec.branches.map((b) => `${b.repo}:${b.name}`)).toEqual([
      'backend:feat/webhook-improvements',
      'backend:fix/SD-3999-probe-recovers-on-2xx',
      'backend:fix/tests-deterministic-culture',
      'frontend:feat/webhook-improvements',
    ]);
    expect(readSessionBranches(sessionIdFor(session))).toEqual(rec);
  });

  it('the facts: the new branches have a commit each, not pushed; the start branch is merged', async () => {
    const sd = await branchFacts(backend, 'fix/SD-3999-probe-recovers-on-2xx');
    expect(sd).toMatchObject({ exists: true, pushed: false, commits: 1, unpushed: 1, merged: false, sha: sdSha });
    expect(await branchFacts(backend, 'feat/webhook-improvements')).toMatchObject({ exists: true, pushed: true, commits: 0, merged: true });
    expect(await branchFacts(backend, 'no/such')).toMatchObject({ exists: false, sha: null });
  });

  it('the header lists all three backend branches, the checked-out one first', async () => {
    const wire = await sessionBranchesNow(session, null);
    const rows = wire!.map((b) => [b.repo, b.name, b.current, b.commits, b.pushed]);
    // The checked-out ones first; the rest newest first (the fixture's moves can share a second: compared as a set).
    expect(rows.slice(0, 2).sort()).toEqual([
      ['backend', 'fix/tests-deterministic-culture', true, 1, false],
      ['frontend', 'feat/webhook-improvements', true, 0, false],
    ]);
    expect(rows.slice(2).sort()).toEqual([
      ['backend', 'feat/webhook-improvements', false, 0, true],
      ['backend', 'fix/SD-3999-probe-recovers-on-2xx', false, 1, false],
    ]);
    expect(wire?.find((b) => b.name === 'feat/webhook-improvements' && b.repo === 'backend')?.merged).toBe(true);
  });

  it("the Diff picker's commits: the other branch's commit is listed, under its branch", () => {
    const others = [
      { path: backend, name: 'fix/SD-3999-probe-recovers-on-2xx', from: 'origin/dev' },
      { path: backend, name: 'feat/webhook-improvements' },
    ];
    const commits = sessionCommits(session, others);
    const sd = commits.find((c) => c.sha === sdSha);
    expect(sd).toMatchObject({
      repo: 'backend',
      branch: 'fix/SD-3999-probe-recovers-on-2xx',
      subject: 'fix(SD-3999): webhook recovers only on a 2xx probe',
    });
    // The merged branch is still the session's work: its commit is listed under it, merged into dev or not
    // (reported: the Diff tab lost every branch once it merged).
    expect(commits.filter((c) => c.branch === 'feat/webhook-improvements').map((c) => c.subject)).toEqual([
      'feat(SD-3999): webhook delivery log',
    ]);
  });

  it("each other branch's whole work is a span: from where it was made to its tip, its own files only, merged too", () => {
    const others = historyBranchRefs(session, backfillSessionBranches(session, T0), checkedOutBranch);
    // Every recorded branch but the one checked out, in each repo; the frontend has only its checked-out one.
    expect(others.map((o) => o.name).sort()).toEqual(['feat/webhook-improvements', 'fix/SD-3999-probe-recovers-on-2xx']);
    // The start commit came from each branch's own reflog ("branch: Created from origin/dev").
    expect(others.every((o) => /^[0-9a-f]{40}$/.test(o.start ?? ''))).toBe(true);
    const { spans } = sessionHistory(session, others);
    for (const name of ['feat/webhook-improvements', 'fix/SD-3999-probe-recovers-on-2xx']) {
      const span = spans.find((s) => s.branch === name)!;
      expect(span).toMatchObject({ repo: 'backend', tip: git(backend, 'rev-parse', name) });
      const diff = computeSessionRange(
        session,
        { kind: 'commit', repo: 'backend', sha: span.base },
        { kind: 'commit', repo: 'backend', sha: span.tip },
      );
      if ('error' in diff) throw new Error(diff.error);
      const files = diff.repos.flatMap((r) => r.files.map((f) => f.path));
      expect(files).toEqual([name === 'feat/webhook-improvements' ? 'webhook.cs' : 'probe.cs']);
    }
  });

  it('a branch deleted after its merge is still listed from the tip recorded while it was there', () => {
    const tip = git(backend, 'rev-parse', 'feat/webhook-improvements');
    const start = historyBranchRefs(session, backfillSessionBranches(session, T0), checkedOutBranch).find(
      (o) => o.name === 'feat/webhook-improvements',
    )!.start;
    const gone = { path: backend, name: 'no-longer/a-branch', tip, ...(start ? { start } : {}) };
    const { commits, spans } = sessionHistory(session, [gone]);
    expect(commits.filter((c) => c.branch === 'no-longer/a-branch').map((c) => c.subject)).toEqual(['feat(SD-3999): webhook delivery log']);
    expect(spans.map((s) => s.branch)).toEqual(['no-longer/a-branch']);
    // A recorded tip the repo no longer has: nothing to list, nothing thrown.
    const none = sessionHistory(session, [{ path: backend, name: 'no-longer/a-branch', tip: 'f'.repeat(40) }]);
    expect(none.commits.filter((c) => c.branch)).toEqual([]);
    expect(none.spans).toEqual([]);
  });

  it('Ship and the PR watch see the work on the other branch: never done, never archived', async () => {
    const pre = await shipPreflight(session, undefined, { askGh: () => false, askBranch: () => false });
    const be = pre.repos.find((r) => r.name === 'backend')!;
    expect(be.branch).toBe('fix/tests-deterministic-culture');
    expect(be.otherBranches?.map((b) => [b.name, b.unpushed]).sort()).toEqual([
      ['feat/webhook-improvements', 0],
      ['fix/SD-3999-probe-recovers-on-2xx', 1],
    ]);
    expect(workElsewhere(pre)).toEqual(['backend: fix/SD-3999-probe-recovers-on-2xx — 1 commit not pushed']);
  });

  it('the turn-end hook records a branch checked out since, reading HEAD files; idempotent', async () => {
    saveHistory([session]);
    git(backend, 'checkout', '-q', '-b', 'fix/third', 'origin/dev');
    const later = new Date(T0.getTime() + 60_000);
    // Through the hook itself (io.recordBranches left to its default).
    await runTurnHook(false, { cwd: backend }, { write: () => {}, post: async () => {} });
    const rec = readSessionBranches(sessionIdFor(session))!;
    const third = rec.branches.find((b) => b.name === 'fix/third');
    expect(third).toMatchObject({ repo: 'backend', from: 'origin/dev' });
    // Again: nothing new, no write needed (the same record comes back).
    const again = recordCheckedOutBranches(session, later);
    expect(again?.branches.filter((b) => b.name === 'fix/third')).toHaveLength(1);
    recordBranchesFor(path.join(tmp, 'not-a-session')); // outside a session: nothing, no throw
  });

  it('what the facts saw is kept: a branch deleted is gone (from then), seen merged, pushed once', () => {
    const id = sessionIdFor(session);
    noteBranchFacts(id, [{ repo: 'backend', name: 'feat/webhook-improvements', exists: false, merged: true, pushed: true }], T0);
    const b = readSessionBranches(id)!.branches.find((x) => x.repo === 'backend' && x.name === 'feat/webhook-improvements')!;
    expect(b).toMatchObject({ gone: T0.toISOString(), merged: true, pushed: true });
    // While a branch is there its tip is kept: the Diff tab shows it from that once it is deleted.
    noteBranchFacts(id, [{ repo: 'backend', name: 'fix/SD-3999-probe-recovers-on-2xx', exists: true, merged: false, sha: sdSha }], T0);
    const sd = readSessionBranches(id)!.branches.find((x) => x.name === 'fix/SD-3999-probe-recovers-on-2xx')!;
    expect(sd.tip).toBe(sdSha);
    // Shape-checked like the rest: a tip that isn't a commit's name is dropped, not the branch.
    expect(cleanBranches({ branches: [{ ...sd, tip: 'x; rm -rf', start: 42 }] })?.branches[0]).not.toHaveProperty('tip');
    // Gone and merged for long enough: hidden from the header, still in the record.
    const wire = branchesWire(readSessionBranches(id), () => null, new Map(), null, T0.getTime() + GONE_SHOWN_MS);
    expect(wire?.some((w) => w.name === 'feat/webhook-improvements' && w.repo === 'backend')).toBe(false);
  });

  it('purged with the session', () => {
    const id = sessionIdFor(session);
    noteBranches(id, [{ repo: 'backend', name: 'x' }]);
    tx((d) => purgeSessionRows(d, id));
    expect(readSessionBranches(id)).toBeNull();
  });
});

describe('branchJobs / branchesWire (pure)', () => {
  const rec = (names: string[]): SessionBranches => ({
    branches: names.map((n) => ({ repo: 'api', name: n, firstSeen: T0.toISOString(), lastSeen: T0.toISOString() })),
  });
  it('nothing for a session that stayed on one branch', () => {
    const s = { target: 'api', isGroup: false, paths: ['/nowhere'] };
    expect(branchJobs(s, rec(['feat/x']), T0.getTime())).toBeNull();
    expect(branchesWire(rec(['feat/x']), () => 'feat/x', new Map(), null, T0.getTime())).toBeNull();
  });
  it("a branch's PR from the PR watch's check: the checked-out one's, or another's", () => {
    const pr = (n: number, state: 'OPEN' | 'MERGED') => ({
      number: n,
      url: `u/${n}`,
      state,
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      checks: 'pass' as const,
      headSha: 'h',
    });
    const ci = {
      checkedAt: T0.toISOString(),
      repos: [{ name: 'api', branch: 'fix/new', pr: pr(12, 'OPEN'), otherPrs: [{ branch: 'feat/x', pr: pr(9, 'MERGED') }], done: false }],
    };
    const wire = branchesWire(rec(['feat/x', 'fix/new']), () => 'fix/new', new Map(), ci, T0.getTime())!;
    expect(wire.map((b) => [b.name, b.current, b.pr?.number, b.pr?.kind, b.merged ?? false])).toEqual([
      ['fix/new', true, 12, 'in_review', false],
      ['feat/x', false, 9, 'merged', true],
    ]);
  });
});
