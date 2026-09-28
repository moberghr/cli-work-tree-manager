import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runShipAction, shipPreflight } from '../../src/core/ship.js';
import { computeDiffStat } from '../../src/core/diff-stat.js';
import type { WorktreeSession } from '../../src/core/history.js';

/**
 * Ship against real git: a bare repo as "origin", a clone as the worktree,
 * and a fake `gh` (fixtures/fake-gh.cjs) first on PATH — resolved through
 * the real cross-spawn runner, as a .cmd shim on Windows.
 */

const FAKE_GH = path.resolve(__dirname, 'fixtures/fake-gh.cjs');
let dir: string;
let wt: string;
let origin: string;
let ghLog: string;
let session: WorktreeSession;
const saved = { PATH: process.env.PATH, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_GH_STATE: process.env.FAKE_GH_STATE };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const ghCalls = () =>
  fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-real-'));
  origin = path.join(dir, 'origin.git');
  wt = path.join(dir, 'wt');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, wt);
  fs.writeFileSync(path.join(wt, 'README.md'), '# app\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'init');
  git(wt, 'push', '-q', 'origin', 'main');
  git(wt, 'remote', 'set-head', 'origin', 'main');
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 1;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'add a');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@node "${FAKE_GH}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  }
  ghLog = path.join(dir, 'gh.log');
  process.env.PATH = bin + path.delimiter + saved.PATH;
  process.env.FAKE_GH_LOG = ghLog;
  process.env.FAKE_GH_STATE = path.join(dir, 'gh-state.json');
  session = { target: 'app', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' };
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.FAKE_GH_LOG = saved.FAKE_GH_LOG;
  process.env.FAKE_GH_STATE = saved.FAKE_GH_STATE;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('ship on real git with a fake gh', () => {
  it('preflight sees an unpublished branch, 1 commit vs base, no PR', async () => {
    const [r] = (await shipPreflight(session)).repos;
    expect(r).toMatchObject({ branch: 'feat/x', dirtyFiles: 0, hasUpstream: false, pr: null, commitsVsBase: 1 });
    expect(r.ghError).toBeUndefined(); // the .cmd shim resolved
    expect(r.mergeBlockers).toEqual(['no pull request']);
  });

  it('create-pr publishes the branch, opens the PR, then merge lands it at the checked SHA', async () => {
    const [created] = await runShipAction(session, 'create-pr');
    expect(created).toMatchObject({ ok: true, url: 'https://github.com/acme/app/pull/42' });
    expect(git(wt, 'ls-remote', '--heads', 'origin', 'feat/x')).toContain('refs/heads/feat/x');

    const [pre] = (await shipPreflight(session)).repos;
    expect(pre).toMatchObject({ hasUpstream: true, ahead: 0, pr: { number: 42, state: 'OPEN', checks: 'pass' }, mergeBlockers: [] });

    const [merged] = await runShipAction(session, 'merge', { method: 'squash' });
    expect(merged).toMatchObject({ ok: true, message: 'PR #42 merged (squash)' });
    const mergeCall = ghCalls().find((a) => a[1] === 'merge')!;
    expect(mergeCall).toEqual(['pr', 'merge', '42', '--squash', '--match-head-commit', git(wt, 'rev-parse', 'HEAD')]);
  });

  it('a new unpushed commit blocks the merge instead of merging stale code', async () => {
    await runShipAction(session, 'create-pr');
    fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2;\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'more');
    const [r] = await runShipAction(session, 'merge');
    expect(r).toMatchObject({ ok: false, message: 'not merged: 1 unpushed commit' });
    expect(ghCalls().some((a) => a[1] === 'merge')).toBe(false);
  });

  it('a branch tracking origin/main (how `work tree` forks) is treated as unpublished and pushed with -u', async () => {
    // Regression: @{u} was the base branch, so a plain `git push` failed with
    // "The upstream branch of your current branch does not match the name…".
    git(wt, 'branch', '--set-upstream-to', 'origin/main');
    const [r] = (await shipPreflight(session)).repos;
    expect(r).toMatchObject({ hasUpstream: false, ahead: null });
    const [created] = await runShipAction(session, 'create-pr');
    expect(created).toMatchObject({ ok: true, message: 'PR opened' });
    expect(git(wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/feat/x');
  });

  it('diff stats count tracked changes and untracked files', async () => {
    fs.appendFileSync(path.join(wt, 'README.md'), 'more\nlines\n');
    fs.writeFileSync(path.join(wt, 'new.ts'), 'x\n');
    expect(await computeDiffStat([wt])).toEqual({ added: 2, deleted: 0, files: 2 });
  });
});
