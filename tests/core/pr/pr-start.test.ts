import { describe, expect, it, vi } from 'vitest';
import { resolvePrToStart } from '../../../src/core/pr/pr-start.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';

const config = {
  repos: { api: '/r/api', web: '/r/web', api2: '/r/api-copy', gl: '/r/gl' },
  groups: { full: ['api', 'web'] },
};
const origins: Record<string, string> = {
  '/r/api': 'git@github.com:Acme/API.git',
  '/r/api-copy': 'https://github.com/acme/api.git',
  '/r/web': 'https://github.com/acme/web.git',
  '/r/gl': 'git@gitlab.com:acme/gl.git',
};
const gitConfig = (p: string) => (origins[p] ? `[remote "origin"]\n\turl = ${origins[p]}\n` : null);

const view = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 12,
    title: 'Add export',
    url: 'https://github.com/acme/api/pull/12',
    headRefName: 'feat/export',
    baseRefName: 'main',
    state: 'OPEN',
    isCrossRepository: false,
    author: { login: 'ana' },
    headRepositoryOwner: { login: 'acme' },
    ...over,
  });
const runner = (stdout: string, code = 0, stderr = '') => vi.fn<CommandRunner>(async () => ({ code, stdout, stderr }));

describe('resolvePrToStart', () => {
  it("finds a link's repo by its origin and returns the PR's branch", async () => {
    const run = runner(view());
    const r = await resolvePrToStart('https://github.com/acme/api/pull/12', config, undefined, { run, gitConfig });
    expect(r).toEqual({
      ok: true,
      pr: {
        alias: 'api',
        number: 12,
        title: 'Add export',
        url: 'https://github.com/acme/api/pull/12',
        branch: 'feat/export',
        base: 'main',
        author: 'ana',
      },
    });
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'view', '12', '--repo', 'acme/api']), '/r/api');
  });

  it('a target named beside a link must hold it: that repo (of two sharing the origin), or a group with it', async () => {
    const run = runner(view());
    const r = await resolvePrToStart('https://github.com/acme/api/pull/12', config, 'api2', { run, gitConfig });
    expect(r.ok && r.pr.alias).toBe('api2');
    const inGroup = await resolvePrToStart(
      'https://github.com/acme/api/pull/12',
      { ...config, groups: { full: ['web', 'api2'] } },
      'full',
      {
        run,
        gitConfig,
      },
    );
    expect(inGroup.ok && inGroup.pr.alias).toBe('api2');
    expect(await resolvePrToStart('https://github.com/acme/api/pull/12', config, 'web', { run, gitConfig })).toEqual({
      ok: false,
      error: 'PR #12 is in api / api2 (acme/api), not web.',
    });
  });

  it('a number needs a repo: refused without one, and for a group', async () => {
    const run = runner(view());
    expect(await resolvePrToStart('#12', config, undefined, { run, gitConfig })).toMatchObject({
      ok: false,
      error: expect.stringContaining('which repo'),
    });
    expect(await resolvePrToStart('#12', config, 'full', { run, gitConfig })).toMatchObject({
      ok: false,
      error: expect.stringContaining('is a group'),
    });
    expect(await resolvePrToStart('#12', config, 'nope', { run, gitConfig })).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
    const ok = await resolvePrToStart('12', config, 'web', { run, gitConfig });
    expect(ok.ok && ok.pr.alias).toBe('web');
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['--repo', 'acme/web']), '/r/web');
  });

  it("refuses a repo you don't have, one not on GitHub, and what isn't a PR", async () => {
    const run = runner(view());
    expect(await resolvePrToStart('https://github.com/other/thing/pull/1', config, undefined, { run, gitConfig })).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't one of your repos"),
    });
    expect(await resolvePrToStart('#1', config, 'gl', { run, gitConfig })).toMatchObject({
      ok: false,
      error: expect.stringContaining('github.com'),
    });
    expect(await resolvePrToStart('hello', config, 'api', { run, gitConfig })).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a fork's PR: its branch isn't on origin", async () => {
    const r = await resolvePrToStart('#12', config, 'api', {
      run: runner(view({ isCrossRepository: true, headRepositoryOwner: { login: 'stranger' } })),
      gitConfig,
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('fork (stranger)') });
  });

  it('refuses a PR that is merged or closed', async () => {
    const r = await resolvePrToStart('#12', config, 'api', { run: runner(view({ state: 'MERGED' })), gitConfig });
    expect(r).toEqual({ ok: false, error: 'PR #12 is merged.' });
  });

  it("says what gh said, and when gh isn't there", async () => {
    expect(await resolvePrToStart('#12', config, 'api', { run: runner('', 127), gitConfig })).toMatchObject({
      ok: false,
      error: expect.stringContaining('gh) not found'),
    });
    expect(
      await resolvePrToStart('#99', config, 'api', { run: runner('', 1, 'GraphQL: Could not resolve to a PullRequest\nmore'), gitConfig }),
    ).toEqual({ ok: false, error: 'PR #99 in acme/api: GraphQL: Could not resolve to a PullRequest' });
    expect(await resolvePrToStart('#12', config, 'api', { run: runner('not json'), gitConfig })).toMatchObject({ ok: false });
    expect(await resolvePrToStart('#12', config, 'api', { run: runner(view({ headRefName: '' })), gitConfig })).toMatchObject({
      ok: false,
    });
  });

  describe('a local branch of the same name', () => {
    /** gh answers the view; git: does the local branch exist, and which way does it stand to the PR's head. */
    const git = (o: { local?: boolean; contains?: number; behind?: number }) =>
      vi.fn<CommandRunner>(async (cmd, args) => {
        const out = (code: number, stdout = '') => ({ code, stdout, stderr: '' });
        if (cmd === 'gh') return out(0, view({ headRefOid: 'pr-head' }));
        if (args[0] === 'rev-parse') return out(o.local ? 0 : 1);
        if (args[0] === 'fetch') return out(0);
        if (args[0] === 'merge-base') return out(args[2] === 'pr-head' ? (o.contains ?? 1) : (o.behind ?? 1));
        return out(1);
      });

    it('none, ahead of the PR (your commits on top) or behind it (it fast-forwards): fine', async () => {
      for (const o of [{ local: false }, { local: true, contains: 0 }, { local: true, contains: 1, behind: 0 }])
        expect((await resolvePrToStart('#12', config, 'api', { run: git(o), gitConfig })).ok).toBe(true);
    });

    it('fetches the PR branch first, and refuses one gone another way (a force-push, or an unrelated branch)', async () => {
      const run = git({ local: true, contains: 1, behind: 1 });
      const r = await resolvePrToStart('#12', config, 'api', { run, gitConfig });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('have gone separate ways') });
      expect(run).toHaveBeenCalledWith('git', ['fetch', '--quiet', 'origin', 'feat/export'], '/r/api');
    });

    it("when git can't tell (the PR's head isn't here), it doesn't refuse", async () => {
      expect((await resolvePrToStart('#12', config, 'api', { run: git({ local: true, contains: 128, behind: 128 }), gitConfig })).ok).toBe(
        true,
      );
    });
  });
});
