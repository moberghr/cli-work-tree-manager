import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mergeSelected, runShipAction, shipPreflight } from '../../src/core/pr/ship.js';
import { computeDiffStat } from '../../src/core/diff/diff-stat.js';
import type { WorktreeSession } from '../../src/core/sessions/history.js';

/**
 * Ship against real git: a bare repo per "origin", a clone per worktree,
 * and a fake `gh` (fixtures/fake-gh.cjs) first on PATH — resolved through
 * the real cross-spawn runner, as a .cmd shim on Windows. Each test spawns
 * dozens of git/gh processes, so they get a larger budget than the 20 s
 * default (the full parallel suite on Windows is slow to spawn).
 */

const FAKE_GH = path.resolve(__dirname, 'fixtures/fake-gh.cjs');
let dir: string;
let ghLog: string;
let ghState: string;
const saved = { PATH: process.env.PATH, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_GH_STATE: process.env.FAKE_GH_STATE };

function git(cwd: string, ...args: string[]): string {
  // Synchronous git blocks the worker's event loop — a hang can't be timed
  // out by vitest — so bound it here and say which command stalled.
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8', timeout: 30_000 });
  if (r.error) throw new Error(`git ${args.join(' ')} did not finish: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd: string, file: string, content = 'x\n'): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
}
/** origin (bare) + clone on main, then a feature branch tracking origin/main
 *  — exactly how `work tree` leaves a new branch. */
function makeRepo(name: string, branch = 'feat/x'): string {
  const origin = path.join(dir, `${name}.git`);
  const wt = path.join(dir, 'wt', name);
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(dir, 'clone', '-q', origin, wt);
  commit(wt, 'README.md', `# ${name}\n`);
  git(wt, 'push', '-q', 'origin', 'main');
  git(wt, 'remote', 'set-head', 'origin', 'main');
  git(wt, 'checkout', '-q', '-b', branch, '--track', 'origin/main');
  return wt;
}
const ghCalls = () =>
  fs.existsSync(ghLog)
    ? fs
        .readFileSync(ghLog, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    : [];
/** Someone else pushed to the PR after you looked. */
function movePrHead(wt: string, sha: string): void {
  const all = JSON.parse(fs.readFileSync(ghState, 'utf-8'));
  all[wt.toLowerCase()].headRefOid = sha;
  fs.writeFileSync(ghState, JSON.stringify(all));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-real-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@node "${FAKE_GH}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  }
  ghLog = path.join(dir, 'gh.log');
  ghState = path.join(dir, 'gh-state.json');
  process.env.PATH = bin + path.delimiter + saved.PATH;
  process.env.FAKE_GH_LOG = ghLog;
  process.env.FAKE_GH_STATE = ghState;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.FAKE_GH_LOG = saved.FAKE_GH_LOG;
  process.env.FAKE_GH_STATE = saved.FAKE_GH_STATE;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const single = (wt: string): WorktreeSession => ({
  target: 'app',
  branch: 'feat/x',
  isGroup: false,
  paths: [wt],
  createdAt: '',
  lastAccessedAt: '',
});

describe('ship on real git with a fake gh — single repo', { timeout: 60_000 }, () => {
  it('create-pr publishes the branch (fixing base tracking), then merge lands it at the reviewed SHA', async () => {
    const wt = makeRepo('app');
    commit(wt, 'a.ts');
    const s = single(wt);
    const [pre] = (await shipPreflight(s)).repos;
    expect(pre).toMatchObject({ hasUpstream: false, tracksRemote: false, pr: null, commitsVsBase: 1, done: false });
    expect(pre.ghError).toBeUndefined(); // the .cmd shim resolved

    const [created] = await runShipAction(s, 'create-pr');
    expect(created).toMatchObject({ ok: true, message: 'PR opened' });
    expect(git(wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/feat/x');

    const [r] = (await shipPreflight(s)).repos;
    expect(r).toMatchObject({ hasUpstream: true, ahead: 0, mergeBlockers: [] });
    const out = await mergeSelected(s, [{ name: 'app', headSha: r.pr!.headSha }], 'squash');
    expect(out).toMatchObject({ mergedAny: true, allDone: true });
    expect(ghCalls().find((a) => a[1] === 'merge')).toEqual([
      'pr',
      'merge',
      String(r.pr!.number),
      '--squash',
      '--match-head-commit',
      git(wt, 'rev-parse', 'HEAD'),
    ]);
  });

  it('pushed without -u (still tracking origin/main) + a new local commit → blocked, not merged stale', async () => {
    // Reviewed bug: this looked "unpublished", hid the unpushed commit, and
    // merge landed the older remote head.
    const wt = makeRepo('app');
    commit(wt, 'a.ts');
    git(wt, 'push', '-q', 'origin', 'feat/x'); // no -u: tracking stays origin/main
    await runShipAction(single(wt), 'create-pr');
    git(wt, 'branch', '--set-upstream-to', 'origin/main');
    commit(wt, 'b.ts');
    const [r] = (await shipPreflight(single(wt))).repos;
    expect(r).toMatchObject({ hasUpstream: true, tracksRemote: false, ahead: 1 });
    expect(r.mergeBlockers).toContain('1 unpushed commit');
    const out = await mergeSelected(single(wt), [{ name: 'app', headSha: r.pr!.headSha }], 'squash');
    expect(out.mergedAny).toBe(false);
    expect(ghCalls().some((a) => a[1] === 'merge')).toBe(false);
  });

  it('the PR moved after you looked → the whole merge is refused', async () => {
    const wt = makeRepo('app');
    commit(wt, 'a.ts');
    await runShipAction(single(wt), 'create-pr');
    const seen = (await shipPreflight(single(wt))).repos[0].pr!.headSha;
    movePrHead(wt, 'deadbeefdeadbeef');
    const out = await mergeSelected(single(wt), [{ name: 'app', headSha: seen }], 'squash');
    expect(out.mergedAny).toBe(false);
    expect(out.results[0].message).toMatch(/changed since you looked/);
    expect(ghCalls().some((a) => a[1] === 'merge')).toBe(false);
  });

  it('diff stats count tracked changes and untracked files', async () => {
    const wt = makeRepo('app');
    fs.appendFileSync(path.join(wt, 'README.md'), 'more\nlines\n');
    fs.writeFileSync(path.join(wt, 'new.ts'), 'x\n');
    expect(await computeDiffStat([wt])).toEqual({ added: 2, deleted: 0, files: 2 });
  });
});

describe('ship on real git — work after a merge is not "done"', { timeout: 60_000 }, () => {
  it('a follow-up commit on a merged backend keeps the group open when frontend merges', async () => {
    const backend = makeRepo('backend');
    const frontend = makeRepo('frontend');
    commit(backend, 'api.ts');
    commit(frontend, 'ui.tsx');
    const s: WorktreeSession = {
      target: 'shop',
      branch: 'feat/x',
      isGroup: true,
      paths: [backend, frontend],
      createdAt: '',
      lastAccessedAt: '',
    };
    await runShipAction(s, 'create-pr');
    let repos = (await shipPreflight(s)).repos;
    const b = repos.find((r) => r.name === 'backend')!;
    await mergeSelected(s, [{ name: 'backend', headSha: b.pr!.headSha }], 'squash');

    commit(backend, 'fixup.ts'); // follow-up after the merge, not pushed
    repos = (await shipPreflight(s)).repos;
    const be = repos.find((r) => r.name === 'backend')!;
    expect(be).toMatchObject({ done: false, ahead: 1 });
    expect(be.mergeBlockers).toContain('1 unpushed commit');

    const f = repos.find((r) => r.name === 'frontend')!;
    const out = await mergeSelected(s, [{ name: 'frontend', headSha: f.pr!.headSha }], 'squash');
    // Frontend merges, but the group is NOT all done → the route won't archive.
    expect(out).toMatchObject({ mergedAny: true, allDone: false });

    // And push ships the follow-up instead of skipping it as "already merged".
    const pushed = await runShipAction(s, 'push');
    expect(pushed.find((r) => r.repo === 'backend')).toMatchObject({ ok: true, message: 'pushed' });
  });
});

describe('ship on real git — a group shipped in parts', { timeout: 60_000 }, () => {
  it('merge backend now, frontend later; an untouched docs repo never gets in the way', async () => {
    const backend = makeRepo('backend');
    const frontend = makeRepo('frontend');
    const docs = makeRepo('docs'); // no commits on the branch
    commit(backend, 'api.ts');
    commit(frontend, 'ui.tsx');
    const s: WorktreeSession = {
      target: 'shop',
      branch: 'feat/x',
      isGroup: true,
      paths: [backend, frontend, docs],
      createdAt: '',
      lastAccessedAt: '',
    };

    // create-pr opens PRs for the two that changed, skips docs.
    const created = await runShipAction(s, 'create-pr');
    expect(created.map((r) => [r.repo, r.ok])).toEqual([
      ['backend', true],
      ['frontend', true],
      ['docs', true],
    ]);
    expect(created.find((r) => r.repo === 'docs')?.message).toMatch(/skipped/);

    let repos = (await shipPreflight(s)).repos;
    expect(repos.find((r) => r.name === 'docs')).toMatchObject({ done: true, doneReason: 'untouched' });

    // Step 1: only backend.
    const b = repos.find((r) => r.name === 'backend')!;
    const first = await mergeSelected(s, [{ name: 'backend', headSha: b.pr!.headSha }], 'squash');
    expect(first).toMatchObject({ mergedAny: true, allDone: false });

    // Backend is now DONE — it must not block finishing the group.
    repos = (await shipPreflight(s)).repos;
    expect(repos.find((r) => r.name === 'backend')).toMatchObject({ done: true, doneReason: 'merged', mergeBlockers: [] });

    // Step 2: frontend → everything done.
    const f = repos.find((r) => r.name === 'frontend')!;
    const second = await mergeSelected(s, [{ name: 'frontend', headSha: f.pr!.headSha }], 'squash');
    expect(second).toMatchObject({ mergedAny: true, allDone: true });
    expect(
      ghCalls()
        .filter((a) => a[1] === 'merge')
        .map((a) => a[2]),
    ).toEqual([String(b.pr!.number), String(f.pr!.number)]);
  });
});
