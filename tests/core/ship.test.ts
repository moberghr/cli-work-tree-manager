import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  checksFromRollup,
  mergeBlockers,
  runShipAction,
  shipPreflight,
  type CommandRunner,
  type RepoShipState,
} from '../../src/core/ship.js';
import type { WorktreeSession } from '../../src/core/history.js';

/**
 * A scripted git/gh: per repo dir, what each command returns. Records every
 * call so tests can assert exactly what would have been run.
 */
interface RepoScript {
  branch?: string;
  porcelain?: string;
  upstream?: string | null;
  counts?: string; // "behind ahead"
  baseRef?: string | null;
  vsBase?: number;
  pr?: object | null; // gh pr view JSON; null → "no pull requests found"
  ghMissing?: boolean;
  fail?: Partial<Record<'push' | 'pr create' | 'pr merge', string>>;
}

function fakeRunner(scripts: Record<string, RepoScript>) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    const s = scripts[cwd] ?? {};
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const err = (stderr: string, code = 1) => ({ code, stdout: '', stderr });
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok((s.branch ?? 'feat/x') + '\n');
      if (a === 'status --porcelain') return ok(s.porcelain ?? '');
      if (a.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) {
        return s.upstream ? ok(s.upstream + '\n') : err('no upstream', 128);
      }
      if (a.startsWith('rev-list --left-right')) return ok((s.counts ?? '0 0') + '\n');
      if (a === 'rev-parse --abbrev-ref origin/HEAD') return s.baseRef === null ? err('x', 128) : ok((s.baseRef ?? 'origin/main') + '\n');
      if (a.startsWith('rev-list --count')) return ok(String(s.vsBase ?? 1) + '\n');
      if (args[0] === 'push') return s.fail?.push ? err(s.fail.push) : ok();
      return ok();
    }
    if (cmd === 'gh') {
      if (s.ghMissing) return err('spawn gh ENOENT', 127);
      if (args[0] === 'pr' && args[1] === 'view') {
        return s.pr ? ok(JSON.stringify(s.pr)) : err('no pull requests found for branch "feat/x"');
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return s.fail?.['pr create'] ? err(s.fail['pr create']) : ok('https://github.com/o/r/pull/7\n');
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return s.fail?.['pr merge'] ? err(s.fail['pr merge']) : ok();
      }
    }
    return err('unexpected ' + cmd + ' ' + args.join(' '));
  };
  return { run, calls };
}

const P = (name: string) => path.resolve('/wt', name);
const single = (p = P('api')): WorktreeSession => ({
  target: 'api', branch: 'feat/x', isGroup: false, paths: [p], createdAt: '', lastAccessedAt: '',
});
const group = (...names: string[]): WorktreeSession => ({
  target: 'shop', branch: 'feat/x', isGroup: true, paths: names.map(P), createdAt: '', lastAccessedAt: '',
});
const openPr = (over: object = {}) => ({
  number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', isDraft: false,
  mergeStateStatus: 'CLEAN', headRefOid: 'abc123', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...over,
});

describe('checksFromRollup', () => {
  it('fail beats pending beats pass; empty is none', () => {
    expect(checksFromRollup([])).toBe('none');
    expect(checksFromRollup(undefined)).toBe('none');
    expect(checksFromRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass');
    expect(checksFromRollup([{ status: 'IN_PROGRESS', conclusion: null }, { conclusion: 'SUCCESS', status: 'COMPLETED' }])).toBe('pending');
    expect(checksFromRollup([{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE', status: 'COMPLETED' }])).toBe('fail');
    expect(checksFromRollup([{ state: 'PENDING' }])).toBe('pending'); // commit-status style
  });
});

describe('mergeBlockers', () => {
  const base: Omit<RepoShipState, 'mergeBlockers'> = {
    name: 'api', path: '/x', branch: 'feat/x', dirtyFiles: 0, hasUpstream: true, ahead: 0, behind: 0,
    pr: { number: 1, url: '', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'a' },
  };
  it('is empty for a clean, pushed, green, open PR', () => {
    expect(mergeBlockers(base)).toEqual([]);
  });
  it('lists every reason, in words', () => {
    const b = mergeBlockers({
      ...base, dirtyFiles: 2, ahead: 1,
      pr: { ...base.pr!, isDraft: true, mergeStateStatus: 'DIRTY', checks: 'fail' },
    });
    expect(b).toEqual([
      '2 uncommitted files — commit or stash first',
      '1 unpushed commit',
      'pull request is a draft',
      'merge conflicts with the base branch',
      'checks failing',
    ]);
    expect(mergeBlockers({ ...base, pr: null })).toEqual(['no pull request']);
    expect(mergeBlockers({ ...base, pr: { ...base.pr!, mergeStateStatus: 'BLOCKED', checks: 'pending' } }))
      .toEqual(['blocked by branch protection (reviews or required checks)', 'checks still running']);
  });
});

describe('shipPreflight', () => {
  it('reads dirty files, upstream counts and the PR', async () => {
    const { run } = fakeRunner({ [P('api')]: { porcelain: ' M a.ts\n?? b.ts\n', upstream: 'origin/feat/x', counts: '1 3', pr: openPr() } });
    const { repos } = await shipPreflight(single(), run);
    expect(repos[0]).toMatchObject({
      name: 'api', dirtyFiles: 2, hasUpstream: true, ahead: 3, behind: 1,
      pr: { number: 12, checks: 'pass', headSha: 'abc123' },
    });
    expect(repos[0].mergeBlockers).toContain('2 uncommitted files — commit or stash first');
  });

  it('reports a missing gh clearly', async () => {
    const { run } = fakeRunner({ [P('api')]: { ghMissing: true } });
    const { repos } = await shipPreflight(single(), run);
    expect(repos[0].ghError).toMatch(/gh\) not found/);
    expect(repos[0].pr).toBeNull();
  });

  it('names group repos by folder', async () => {
    const { run } = fakeRunner({});
    const { repos } = await shipPreflight(group('backend', 'frontend'), run);
    expect(repos.map((r) => r.name)).toEqual(['backend', 'frontend']);
  });
});

describe('runShipAction', () => {
  it('push publishes a branch without upstream with -u, and skips when up to date', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: { upstream: null } });
    const [r] = await runShipAction(single(), 'push', {}, run);
    expect(r).toMatchObject({ ok: true, message: 'published feat/x' });
    expect(calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', 'feat/x']);

    const up = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', counts: '0 0' } });
    expect((await runShipAction(single(), 'push', {}, up.run))[0].message).toBe('nothing to push');
    expect(up.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('an upstream with another name (the base, origin/main) is not the branch\'s upstream', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: { upstream: 'origin/main', counts: '0 1' } });
    const [pre] = (await shipPreflight(single(), run)).repos;
    expect(pre).toMatchObject({ hasUpstream: false, ahead: null });
    await runShipAction(single(), 'push', {}, run);
    expect(calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', 'feat/x']);
  });

  it('create-pr pushes first, then opens the PR (draft on request)', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', counts: '0 2' } });
    const [r] = await runShipAction(single(), 'create-pr', { draft: true }, run);
    expect(r).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/7', message: 'draft PR opened' });
    const order = calls.filter((c) => c.args[0] === 'push' || (c.cmd === 'gh' && c.args[1] === 'create'));
    expect(order.map((c) => c.cmd)).toEqual(['git', 'gh']);
    expect(order[1].args).toEqual(['pr', 'create', '--fill', '--head', 'feat/x', '--draft']);
  });

  it('create-pr leaves an already-open PR alone and stops on a failed push', async () => {
    const open = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', pr: openPr() } });
    expect((await runShipAction(single(), 'create-pr', {}, open.run))[0].message).toBe('PR #12 already open');
    const bad = fakeRunner({ [P('api')]: { upstream: null, fail: { push: 'rejected: non-fast-forward' } } });
    const [r] = await runShipAction(single(), 'create-pr', {}, bad.run);
    expect(r).toMatchObject({ ok: false, message: 'rejected: non-fast-forward' });
    expect(bad.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('merge passes the method and the head SHA guard', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', pr: openPr() } });
    const [r] = await runShipAction(single(), 'merge', { method: 'rebase' }, run);
    expect(r).toMatchObject({ ok: true, message: 'PR #12 merged (rebase)' });
    expect(calls.find((c) => c.args[1] === 'merge')?.args).toEqual(['pr', 'merge', '12', '--rebase', '--match-head-commit', 'abc123']);
  });

  it('merge refuses with the blockers instead of trusting the client', async () => {
    const { run, calls } = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', pr: openPr({ statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }) } });
    const [r] = await runShipAction(single(), 'merge', {}, run);
    expect(r).toMatchObject({ ok: false, message: 'not merged: checks failing' });
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('group merge is all-or-nothing and skips untouched sub-repos', async () => {
    const scripts = {
      [P('backend')]: { upstream: 'origin/feat/x', pr: openPr() },
      [P('frontend')]: { upstream: 'origin/feat/x', pr: openPr({ number: 13, isDraft: true }) },
      [P('docs')]: { upstream: null, vsBase: 0 },
    };
    const blocked = fakeRunner(scripts);
    const res = await runShipAction(group('backend', 'frontend', 'docs'), 'merge', {}, blocked.run);
    expect(blocked.calls.some((c) => c.args[1] === 'merge')).toBe(false);
    expect(res.find((r) => r.repo === 'backend')).toMatchObject({ ok: false, message: 'not merged: another repo in this group is blocked' });
    expect(res.find((r) => r.repo === 'frontend')?.message).toContain('draft');
    expect(res.find((r) => r.repo === 'docs')).toMatchObject({ ok: true, message: 'nothing to merge' });

    const ready = fakeRunner({ ...scripts, [P('frontend')]: { upstream: 'origin/feat/x', pr: openPr({ number: 13 }) } });
    const ok = await runShipAction(group('backend', 'frontend', 'docs'), 'merge', {}, ready.run);
    expect(ok.every((r) => r.ok)).toBe(true);
    expect(ready.calls.filter((c) => c.args[1] === 'merge').map((c) => c.args[2])).toEqual(['12', '13']);
  });

  it('a pushed branch with commits but no PR blocks the merge (not silently skipped)', async () => {
    const { run } = fakeRunner({ [P('api')]: { upstream: 'origin/feat/x', vsBase: 3 } });
    const [r] = await runShipAction(single(), 'merge', {}, run);
    expect(r).toMatchObject({ ok: false, message: 'not merged: no pull request' });
  });

  it('push / create-pr skip a sub-repo with no commits vs the base', async () => {
    const { run, calls } = fakeRunner({ [P('docs')]: { upstream: null, vsBase: 0 } });
    const [r] = await runShipAction(group('docs'), 'create-pr', {}, run);
    expect(r.message).toMatch(/no commits vs the base branch/);
    expect(calls.some((c) => c.args[0] === 'push' || c.args[1] === 'create')).toBe(false);
  });
});
