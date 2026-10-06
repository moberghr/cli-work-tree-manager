import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  checksFromRollup,
  failingFromRollup,
  mergeBlockers,
  mergeSelected,
  runShipAction,
  shipPreflight,
  type CommandRunner,
} from '../../../src/core/pr/ship.js';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

/**
 * A scripted git/gh per repo dir. Records every call so tests can assert
 * exactly what would have run — above all, which `gh pr merge` calls.
 */
interface RepoScript {
  branch?: string;
  head?: string; // local HEAD sha
  porcelain?: string;
  remote?: boolean; // origin/<branch> exists
  tracking?: string | null; // what @{u} resolves to
  counts?: string; // "behind ahead" vs origin/<branch>
  vsBase?: number; // commits vs origin/HEAD
  pr?: Record<string, unknown> | null;
  ghMissing?: boolean;
  fail?: Partial<Record<'push' | 'pr create' | 'pr merge', string>>;
  /** Right after a wake: git times out and gh can't reach GitHub. */
  down?: boolean;
}

const SHA = 'a1b2c3d4e5f6';
function fakeRunner(scripts: Record<string, RepoScript>) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    const s = scripts[cwd] ?? {};
    const branch = s.branch ?? 'feat/x';
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const err = (stderr: string, code = 1) => ({ code, stdout: '', stderr });
    if (s.down) return cmd === 'gh' ? err('error connecting to api.github.com') : err('timed out', 124);
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok(branch + '\n');
      if (a === 'rev-parse HEAD') return ok((s.head ?? SHA) + '\n');
      if (a === 'status --porcelain') return ok(s.porcelain ?? '');
      if (a.startsWith('rev-parse --verify --quiet refs/remotes/origin/')) return s.remote ? ok('x\n') : err('', 1);
      if (a.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) {
        return s.tracking ? ok(s.tracking + '\n') : err('no upstream', 128);
      }
      if (a.startsWith('rev-list --left-right')) return ok((s.counts ?? '0 0') + '\n');
      if (a === 'rev-parse --abbrev-ref origin/HEAD') return ok('origin/main\n');
      if (a.startsWith('rev-list --count')) return ok(String(s.vsBase ?? 1) + '\n');
      if (args[0] === 'push') return s.fail?.push ? err(s.fail.push) : ok();
      return ok();
    }
    if (cmd === 'gh') {
      if (s.ghMissing) return err('spawn gh ENOENT', 127);
      if (args[1] === 'view') return s.pr ? ok(JSON.stringify(s.pr)) : err(`no pull requests found for branch "${branch}"`);
      if (args[1] === 'create') return s.fail?.['pr create'] ? err(s.fail['pr create']) : ok('https://github.com/o/r/pull/7\n');
      if (args[1] === 'merge') return s.fail?.['pr merge'] ? err(s.fail['pr merge']) : ok();
    }
    return err('unexpected ' + cmd + ' ' + args.join(' '));
  };
  return { run, calls, merges: () => calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'merge') };
}

const P = (name: string) => path.resolve('/wt', name);
const single = (): WorktreeSession => ({
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: [P('api')],
  createdAt: '',
  lastAccessedAt: '',
});
const group = (...names: string[]): WorktreeSession => ({
  target: 'shop',
  branch: 'feat/x',
  isGroup: true,
  paths: names.map(P),
  createdAt: '',
  lastAccessedAt: '',
});
const pr = (over: Record<string, unknown> = {}) => ({
  number: 12,
  url: 'https://github.com/o/r/pull/12',
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  headRefOid: SHA,
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...over,
});
/** Pushed, tracking itself, clean, with an open green PR at local HEAD. */
const ready = (over: Partial<RepoScript> = {}): RepoScript => ({
  remote: true,
  tracking: 'origin/feat/x',
  pr: pr(),
  ...over,
});

describe('failingFromRollup', () => {
  it('names failed check runs and commit statuses, with links', () => {
    expect(
      failingFromRollup([
        { conclusion: 'SUCCESS', name: 'build' },
        { conclusion: 'FAILURE', name: 'test', detailsUrl: 'https://ci/1' },
        { state: 'ERROR', context: 'coverage', targetUrl: 'https://cov' },
        { conclusion: 'TIMED_OUT' },
      ]),
    ).toEqual([{ name: 'test', url: 'https://ci/1' }, { name: 'coverage', url: 'https://cov' }, { name: 'check' }]);
    expect(failingFromRollup(null)).toEqual([]);
  });
});

describe('checksFromRollup', () => {
  it('fail beats pending beats pass; empty is none', () => {
    expect(checksFromRollup([])).toBe('none');
    expect(checksFromRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass');
    expect(checksFromRollup([{ status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(checksFromRollup([{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE', status: 'COMPLETED' }])).toBe('fail');
    expect(checksFromRollup([{ state: 'PENDING' }])).toBe('pending');
  });
});

describe('preflight', () => {
  it('a clean, pushed, green PR at local HEAD has no blockers', async () => {
    const { run } = fakeRunner({ [P('api')]: ready() });
    const [r] = (await shipPreflight(single(), run)).repos;
    expect(r).toMatchObject({ hasUpstream: true, tracksRemote: true, ahead: 0, done: false, mergeBlockers: [] });
  });

  it('reads the review decision with the PR (the PR stage: in review, approved), in the same gh call', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: ready({ pr: pr({ reviewDecision: 'APPROVED' }) }) });
    const [r] = (await shipPreflight(single(), run)).repos;
    expect(r.pr?.reviewDecision).toBe('APPROVED');
    expect(calls.filter((c) => c.cmd === 'gh').length).toBe(1);
    const none = fakeRunner({ [P('api')]: ready({ pr: pr({ reviewDecision: null }) }) });
    expect((await shipPreflight(single(), none.run)).repos[0].pr?.reviewDecision).toBeUndefined();
  });

  it('askGh: a repo the caller says not to ask about makes no gh call and reads as no PR (no error)', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: ready({ remote: false }) });
    const asked: Array<{ name: string; hasUpstream: boolean }> = [];
    const [r] = (await shipPreflight(single(), run, { askGh: (x) => (asked.push(x), x.hasUpstream) })).repos;
    expect(asked).toEqual([expect.objectContaining({ name: 'api', hasUpstream: false })]);
    expect(calls.filter((c) => c.cmd === 'gh')).toEqual([]);
    expect(r.pr).toBeNull();
    expect(r.ghError).toBeUndefined();
  });

  it('measures ahead vs origin/<branch> even when tracking points at the base (work tree default)', async () => {
    // The reviewed bug: tracking origin/main made the branch look
    // unpublished, hid 2 unpushed commits, and merge landed the old head.
    const { run } = fakeRunner({ [P('api')]: ready({ tracking: 'origin/main', counts: '0 2', head: 'ffff000' }) });
    const [r] = (await shipPreflight(single(), run)).repos;
    expect(r).toMatchObject({ hasUpstream: true, tracksRemote: false, ahead: 2 });
    expect(r.mergeBlockers).toContain('2 unpushed commits');
  });

  it("blocks when the PR's head is not the local HEAD, or origin has commits you don't", async () => {
    const moved = fakeRunner({ [P('api')]: ready({ head: 'ffff000' }) });
    expect((await shipPreflight(single(), moved.run)).repos[0].mergeBlockers).toContain(
      "the PR's head isn't your local HEAD — push or pull first",
    );
    const behind = fakeRunner({ [P('api')]: ready({ counts: '3 0' }) });
    expect((await shipPreflight(single(), behind.run)).repos[0].mergeBlockers).toContain(
      "origin has 3 commits you don't have locally — pull first",
    );
  });

  it('lists every other blocker in words', () => {
    const base = {
      name: 'api',
      path: '/x',
      branch: 'feat/x',
      localSha: SHA,
      dirtyFiles: 2,
      hasUpstream: true,
      tracksRemote: true,
      ahead: 1,
      behind: 0,
      commitsVsBase: 3,
      pr: { number: 1, url: '', state: 'OPEN' as const, isDraft: true, mergeStateStatus: 'DIRTY', checks: 'fail' as const, headSha: SHA },
    };
    expect(mergeBlockers(base)).toEqual([
      '2 uncommitted files — commit or stash first',
      '1 unpushed commit',
      'pull request is a draft',
      'merge conflicts with the base branch',
      'checks failing',
    ]);
    expect(mergeBlockers({ ...base, dirtyFiles: 0, ahead: 0, pr: null })).toEqual(['no pull request']);
    expect(mergeBlockers({ ...base, dirtyFiles: 0, ahead: 0, hasUpstream: false, pr: null })).toEqual([
      'branch not pushed yet',
      'no pull request',
    ]);
  });

  it('a merged PR or an untouched repo is DONE, never a blocker', async () => {
    const { run } = fakeRunner({
      [P('backend')]: ready({ pr: pr({ state: 'MERGED' }) }),
      [P('docs')]: { vsBase: 0 },
    });
    const repos = (await shipPreflight(group('backend', 'docs'), run)).repos;
    expect(repos.map((r) => [r.name, r.done, r.doneReason, r.mergeBlockers])).toEqual([
      ['backend', true, 'merged', []],
      ['docs', true, 'untouched', []],
    ]);
  });

  it('a repo that couldn\'t be read is never done: a failed gh isn\'t "no PR", a failed git isn\'t "0 commits" (it archived a group with an open PR)', async () => {
    const { run } = fakeRunner({
      [P('backend')]: ready({ pr: pr({ state: 'MERGED' }) }),
      [P('frontend')]: { down: true },
    });
    const repos = (await shipPreflight(group('backend', 'frontend'), run)).repos;
    expect(repos.map((r) => [r.name, r.done])).toEqual([
      ['backend', true],
      ['frontend', false],
    ]);
    expect(repos[1].commitsVsBase).toBeNull();
    expect(repos[1].ghError).toContain('error connecting');
    // gh alone failing (git fine, 0 commits): still not untouched.
    const docs = fakeRunner({ [P('docs')]: { vsBase: 0, pr: null } });
    const ghDown: CommandRunner = (cmd, args, cwd) =>
      cmd === 'gh' ? Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 502' }) : docs.run(cmd, args, cwd);
    const d = (await shipPreflight(group('docs'), ghDown)).repos[0];
    expect([d.done, d.ghError]).toEqual([false, 'HTTP 502']);
  });

  it('a merged PR with work after it (follow-up commit, pushed or not, or an edit) is NOT done', async () => {
    // Reviewed bug: "✓ merged" hid the follow-up, push skipped it, and the
    // session could be archived with unpushed work in it.
    const merged = pr({ state: 'MERGED' });
    const cases: Array<[string, Partial<RepoScript>]> = [
      ['unpushed follow-up', { counts: '0 1' }],
      ['pushed follow-up', { head: 'f011' + '0'.repeat(8) }],
      ['uncommitted edit', { porcelain: ' M api.ts\n' }],
    ];
    for (const [label, over] of cases) {
      const { run } = fakeRunner({ [P('api')]: ready({ pr: merged, ...over }) });
      const [r] = (await shipPreflight(single(), run)).repos;
      expect([label, r.done]).toEqual([label, false]);
      expect(r.mergeBlockers.join(' ')).toMatch(/already merged — the new work needs a new PR|uncommitted/);
    }
  });

  it('push and create-pr ship a follow-up after a merge instead of skipping it', async () => {
    const f = fakeRunner({ [P('api')]: ready({ pr: pr({ state: 'MERGED' }), counts: '0 1' }) });
    await runShipAction(single(), 'push', {}, f.run);
    expect(f.calls.some((c) => c.args[0] === 'push')).toBe(true);
    const g = fakeRunner({ [P('api')]: ready({ pr: pr({ state: 'MERGED' }), head: 'f0110000aaaa' }) });
    const [r] = await runShipAction(single(), 'create-pr', {}, g.run);
    expect(r.message).toBe('PR opened');
  });

  it('reports a missing gh clearly', async () => {
    const { run } = fakeRunner({ [P('api')]: { ghMissing: true } });
    expect((await shipPreflight(single(), run)).repos[0].ghError).toMatch(/gh\) not found/);
  });
});

describe('push / create-pr', () => {
  it('push sets tracking with -u unless it already tracks origin/<branch>', async () => {
    const base = fakeRunner({ [P('api')]: { remote: true, tracking: 'origin/main', counts: '0 1' } });
    await runShipAction(single(), 'push', {}, base.run);
    expect(base.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', 'feat/x']);

    const tracked = fakeRunner({ [P('api')]: { remote: true, tracking: 'origin/feat/x', counts: '0 1' } });
    await runShipAction(single(), 'push', {}, tracked.run);
    expect(tracked.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push']);

    const upToDate = fakeRunner({ [P('api')]: { remote: true, tracking: 'origin/feat/x' } });
    expect((await runShipAction(single(), 'push', {}, upToDate.run))[0].message).toBe('nothing to push');
  });

  it('create-pr pushes first, then opens the PR; stops on a failed push', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: {} });
    const [r] = await runShipAction(single(), 'create-pr', { draft: true }, run);
    expect(r).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/7' });
    const order = calls.filter((c) => c.args[0] === 'push' || c.args[1] === 'create').map((c) => c.cmd);
    expect(order).toEqual(['git', 'gh']);

    const bad = fakeRunner({ [P('api')]: { fail: { push: 'rejected' } } });
    expect((await runShipAction(single(), 'create-pr', {}, bad.run))[0]).toMatchObject({ ok: false, message: 'rejected' });
    expect(bad.calls.some((c) => c.args[1] === 'create')).toBe(false);
  });

  it('skips done repos in a group (merged backend, untouched docs) and ships the rest', async () => {
    const { run, calls } = fakeRunner({
      [P('backend')]: ready({ pr: pr({ state: 'MERGED' }) }),
      [P('frontend')]: {},
      [P('docs')]: { vsBase: 0 },
    });
    const res = await runShipAction(group('backend', 'frontend', 'docs'), 'create-pr', {}, run);
    expect(res.map((r) => [r.repo, r.message])).toEqual([
      ['backend', 'already merged'],
      ['frontend', 'PR opened'],
      ['docs', 'untouched — skipped'],
    ]);
    expect(calls.filter((c) => c.args[1] === 'create').map((c) => c.cwd)).toEqual([P('frontend')]);
  });
});

describe('mergeSelected', () => {
  it('merges at the SHA the user saw — never a fresher one', async () => {
    const f = fakeRunner({ [P('api')]: ready() });
    const out = await mergeSelected(single(), [{ name: 'api', headSha: SHA }], 'rebase', f.run);
    expect(out).toMatchObject({ mergedAny: true, allDone: true });
    expect(f.merges()[0].args).toEqual(['pr', 'merge', '12', '--rebase', '--match-head-commit', SHA]);
  });

  it('refuses when the PR moved after the user looked (someone pushed)', async () => {
    // Reviewed bug: the server used the fresh head, merging unseen commits.
    const f = fakeRunner({ [P('api')]: ready({ head: 'b0b0b0b0', pr: pr({ headRefOid: 'b0b0b0b0' }) }) });
    const out = await mergeSelected(single(), [{ name: 'api', headSha: SHA }], 'squash', f.run);
    expect(out).toMatchObject({ mergedAny: false, allDone: false });
    expect(out.results[0].message).toMatch(/changed since you looked/);
    expect(f.merges()).toHaveLength(0);
  });

  it('a group can be shipped in parts: merge only the selected repo; the session is not all done', async () => {
    const f = fakeRunner({
      [P('backend')]: ready(),
      [P('frontend')]: ready({ pr: pr({ number: 13, isDraft: true }) }),
    });
    const out = await mergeSelected(group('backend', 'frontend'), [{ name: 'backend', headSha: SHA }], 'squash', f.run);
    expect(out).toMatchObject({ mergedAny: true, allDone: false });
    expect(f.merges().map((c) => c.cwd)).toEqual([P('backend')]);
  });

  it('finishing a partly merged group: backend merged earlier, frontend now → all done', async () => {
    const f = fakeRunner({
      [P('backend')]: ready({ pr: pr({ state: 'MERGED' }) }),
      [P('frontend')]: ready({ pr: pr({ number: 13 }) }),
      [P('docs')]: { vsBase: 0 },
    });
    const out = await mergeSelected(group('backend', 'frontend', 'docs'), [{ name: 'frontend', headSha: SHA }], 'squash', f.run);
    expect(out).toMatchObject({ mergedAny: true, allDone: true });
    expect(f.merges().map((c) => c.args[2])).toEqual(['13']);
  });

  it('validates every selected repo before merging any', async () => {
    const f = fakeRunner({
      [P('backend')]: ready(),
      [P('frontend')]: ready({ pr: pr({ number: 13, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }) }),
    });
    const out = await mergeSelected(
      group('backend', 'frontend'),
      [
        { name: 'backend', headSha: SHA },
        { name: 'frontend', headSha: SHA },
      ],
      'squash',
      f.run,
    );
    expect(f.merges()).toHaveLength(0);
    expect(out.mergedAny).toBe(false);
    expect(out.results.find((r) => r.repo === 'frontend')?.message).toContain('checks failing');
    expect(out.results.find((r) => r.repo === 'backend')?.message).toBe('not merged: another selected repo is blocked');
  });

  it('refuses a selection naming a done repo or one not in the session', async () => {
    const f = fakeRunner({ [P('backend')]: ready({ pr: pr({ state: 'MERGED' }) }) });
    const done = await mergeSelected(group('backend'), [{ name: 'backend', headSha: SHA }], 'squash', f.run);
    expect(done.results[0].message).toBe('already merged');
    const unknown = await mergeSelected(group('backend'), [{ name: 'nope', headSha: SHA }], 'squash', f.run);
    expect(unknown.results[0].message).toBe('not a repository of this session');
    expect(f.merges()).toHaveLength(0);
  });

  it('stops at the first gh failure and reports exactly what was merged', async () => {
    const f = fakeRunner({
      [P('a')]: ready(),
      [P('b')]: ready({ pr: pr({ number: 13 }), fail: { 'pr merge': 'Head branch was modified' } }),
      [P('c')]: ready({ pr: pr({ number: 14 }) }),
    });
    const sel = ['a', 'b', 'c'].map((name) => ({ name, headSha: SHA }));
    const out = await mergeSelected(group('a', 'b', 'c'), sel, 'squash', f.run);
    expect(out.results.map((r) => [r.repo, r.ok, r.merged ?? false])).toEqual([
      ['a', true, true],
      ['b', false, false],
      ['c', false, false],
    ]);
    expect(out).toMatchObject({ mergedAny: true, allDone: false });
    expect(f.merges().map((c) => c.args[2])).toEqual(['12', '13']);
  });

  it('an empty selection merges nothing', async () => {
    const f = fakeRunner({ [P('api')]: ready() });
    expect((await mergeSelected(single(), [], 'squash', f.run)).mergedAny).toBe(false);
    expect(f.merges()).toHaveLength(0);
  });
});
