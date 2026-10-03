import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mergedParent, type StackSubject } from '../../../src/core/stacks/stack.js';
import { retargetIsClean, retargetOntoMain } from '../../../src/core/stacks/stack-retarget.js';
import { ontoMainPrompt, retargetChildrenOf, syncStacksAfterTurn } from '../../../src/core/stacks/stack-sync.js';
import { saveConfig } from '../../../src/core/platform/config.js';
import { findSession, loadHistory, saveHistory } from '../../../src/core/sessions/history.js';
import { archiveDirFor, writeArchiveRecord, type ArchiveRecord } from '../../../src/core/archive/session-archive.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { sessionStacks } from '../../../src/core/stacks/stack-sessions.js';
import { mountUpdateRoutes } from '../../../src/server/routes/update-routes.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('mergedParent (pure)', () => {
  const s = (id: string, branch: string, over: Partial<StackSubject> = {}): StackSubject => ({ id, target: 'api', branch, ...over });
  it('only an archived parent that merged; never while a live one is there', () => {
    const child = s('c', 'feat/c', { baseBranch: 'feat/p' });
    const archived = s('p', 'feat/p', { archivedAt: '2026-10-01T10:00:00Z' });
    expect(mergedParent(child, [child, archived], undefined, () => true)).toBe(archived);
    expect(mergedParent(child, [child, archived])).toBeNull(); // not known to have merged: its work would be dropped
    expect(mergedParent(child, [child, archived, s('p2', 'feat/p')], undefined, () => true)).toBeNull(); // a live feat/p session: still stacked
  });
});

// origin with main; a clone; the parent's worktree (feat/p) and the child's (feat/c, from feat/p).
let fixture: string;
let tmp: string;
let clone: string;
let parentWt: string;
let childWt: string;
beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'retarget-fixture-'));
  const o = path.join(fixture, 'origin.git');
  const c = path.join(fixture, 'clone');
  git(fixture, 'init', '-q', '--bare', '-b', 'main', o);
  git(fixture, 'clone', '-q', o, c);
  fs.writeFileSync(path.join(c, 'a.txt'), 'a\n');
  git(c, 'add', '.');
  git(c, 'commit', '-q', '-m', 'init');
  git(c, 'push', '-q', '-u', 'origin', 'main');
  git(c, 'remote', 'set-head', 'origin', 'main');
});
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retarget-')));
  fs.cpSync(fixture, tmp, { recursive: true });
  clone = path.join(tmp, 'clone');
  git(clone, 'remote', 'set-url', 'origin', path.join(tmp, 'origin.git'));
  parentWt = path.join(tmp, 'wt-p');
  childWt = path.join(tmp, 'wt-c');
  git(clone, 'worktree', 'add', '-q', '-b', 'feat/p', parentWt);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(parentWt, 'p.txt'), `p${n}\n`);
    git(parentWt, 'add', '.');
    git(parentWt, 'commit', '-q', '-m', `p${n}`);
  }
  git(clone, 'worktree', 'add', '-q', '-b', 'feat/c', childWt, 'feat/p');
  fs.writeFileSync(path.join(childWt, 'c.txt'), 'c\n');
  git(childWt, 'add', '.');
  git(childWt, 'commit', '-q', '-m', 'c1');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** The parent is squash-merged into main (on origin), and its local branch deleted, as archiving does. */
function squashMergeParent() {
  git(clone, 'merge', '-q', '--squash', 'feat/p');
  git(clone, 'commit', '-q', '-m', 'Parent work (#12)');
  git(clone, 'push', '-q', 'origin', 'main');
  const tip = git(parentWt, 'rev-parse', 'HEAD');
  git(clone, 'worktree', 'remove', '--force', parentWt);
  git(clone, 'branch', '-q', '-D', 'feat/p');
  return tip;
}

const now = new Date().toISOString();
const child = (): WorktreeSession => ({ target: 'api', branch: 'feat/c', isGroup: false, paths: [childWt], createdAt: now, lastAccessedAt: now, baseBranch: 'feat/p' });

describe('retargetOntoMain', () => {
  it("a squash-merged parent: only the child's own commit is replayed onto main", async () => {
    const tip = squashMergeParent();
    expect(await retargetIsClean(childWt, { branch: 'feat/p', tip })).toBe(true);
    const r = await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }));
    expect(r).toMatchObject({ ok: true, bases: { [childWt]: 'main' }, results: [{ ok: true, how: 'rebase' }] });
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).toBe('c1');
    expect(git(childWt, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0');
    expect(fs.readFileSync(path.join(childWt, 'p.txt'), 'utf8')).toBe('p2\n');
  });

  it('a conflict is aborted and the worktree left as it was; uncommitted work is refused', async () => {
    const tip = squashMergeParent();
    // Main changes what the child changes too.
    fs.writeFileSync(path.join(clone, 'c.txt'), 'theirs\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'theirs');
    git(clone, 'push', '-q', 'origin', 'main');
    git(childWt, 'fetch', '-q', 'origin');
    const before = git(childWt, 'rev-parse', 'HEAD');
    expect(await retargetIsClean(childWt, { branch: 'feat/p', tip })).toBe(false);
    expect(await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }))).toMatchObject({ ok: false, results: [{ ok: false, conflicts: true }] });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(childWt, 'status', '--porcelain')).toBe('');
    fs.writeFileSync(path.join(childWt, 'wip.txt'), 'wip');
    expect(await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }))).toMatchObject({ ok: false, results: [{ reason: expect.stringContaining('uncommitted') }] });
  });
});

describe('parentTipFor', () => {
  it("a group's repo: the tip of the group's own repo of that folder name, not another project's", async () => {
    const { parentTipFor } = await import('../../../src/core/stacks/stack-retarget.js');
    const parent = { id: 'pid', branch: 'gone/branch', target: 'shop', isGroup: true };
    fs.mkdirSync(archiveDirFor('pid'), { recursive: true });
    writeArchiveRecord({
      sessionId: 'pid', target: 'shop', branch: 'gone/branch', isGroup: true, paths: [], archivedAt: now, worktreeRemoved: true, keptBecause: null, transcripts: [],
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
      tips: { 'other-web': 'aaaa', 'shop-web': 'bbbb' },
    });
    const config = { worktreesRoot: '/w', repos: { 'other-web': '/src/a/web', 'shop-web': '/src/b/web' }, groups: { shop: ['shop-web'] }, copyFiles: [] };
    expect(await parentTipFor(path.join(tmp, 'wt', 'web'), parent, config)).toBe('bbbb');
  });
});

describe('where it left the parent (the review: a parent rewritten before it merged)', () => {
  it('the parent amended after the child branched, then squash-merged: git --fork-point still finds it; only the child is replayed', async () => {
    // Review feedback on the parent: its last commit amended after the child was made from it.
    fs.writeFileSync(path.join(parentWt, 'p.txt'), 'p2 (reviewed)\n');
    git(parentWt, 'commit', '-q', '-a', '--amend', '-m', 'p2 reviewed');
    git(clone, 'merge', '-q', '--squash', 'feat/p');
    git(clone, 'commit', '-q', '-m', 'Parent work (#12)');
    git(clone, 'push', '-q', 'origin', 'main');
    const tip = git(parentWt, 'rev-parse', 'HEAD'); // the branch stays: a squash-merged one isn't deleted
    const r = await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }));
    expect(r.ok).toBe(true);
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).toBe('c1'); // not the old p1/p2 again
    expect(fs.readFileSync(path.join(childWt, 'p.txt'), 'utf8')).toBe('p2 (reviewed)\n');
  });

  it("rewritten and its branch gone (only the archive's tip, which the child isn't built on): refused, nothing changed", async () => {
    fs.writeFileSync(path.join(parentWt, 'p.txt'), 'p2 (reviewed)\n');
    git(parentWt, 'commit', '-q', '-a', '--amend', '-m', 'p2 reviewed');
    git(clone, 'merge', '-q', '--squash', 'feat/p');
    git(clone, 'commit', '-q', '-m', 'Parent work (#12)');
    git(clone, 'push', '-q', 'origin', 'main');
    const tip = git(parentWt, 'rev-parse', 'HEAD');
    git(clone, 'worktree', 'remove', '--force', parentWt);
    git(clone, 'branch', '-q', '-D', 'feat/p');
    const before = git(childWt, 'rev-parse', 'HEAD');
    expect(await retargetIsClean(childWt, { branch: 'feat/p', tip })).toBe(false);
    expect(await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }))).toMatchObject({ ok: false, results: [{ reason: expect.stringContaining('was rewritten') }] });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('a real merge (the parent is in main): a plain rebase, the parent dropped by itself', async () => {
    git(clone, 'merge', '-q', '--no-ff', '--no-edit', 'feat/p');
    git(clone, 'push', '-q', 'origin', 'main');
    const tip = git(parentWt, 'rev-parse', 'HEAD');
    git(clone, 'worktree', 'remove', '--force', parentWt);
    git(clone, 'branch', '-q', '-D', 'feat/p');
    expect(await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }))).toMatchObject({ ok: true });
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).toBe('c1');
  });

  it('stops when told to right before changing a repo (a turn started)', async () => {
    const tip = squashMergeParent();
    const before = git(childWt, 'rev-parse', 'HEAD');
    const r = await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }), undefined, () => 'its Claude started working: stopped');
    expect(r).toMatchObject({ ok: false, results: [{ reason: 'its Claude started working: stopped' }] });
    expect(git(childWt, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('the recorded base: one mainline name, or each repo its own (main and master)', async () => {
    const { setSessionBase } = await import('../../../src/core/sessions/history.js');
    const g: WorktreeSession = { target: 'shop', branch: 'feat/g', isGroup: true, paths: ['/w/a', '/w/b'], createdAt: now, lastAccessedAt: now, baseBranches: { '/w/a': 'feat/x', '/w/b': 'feat/x' } };
    saveHistory([g]);
    await setSessionBase('shop', 'feat/g', { '/w/a': 'main', '/w/b': 'main' });
    expect(findSession(loadHistory(), 'shop', 'feat/g')).toMatchObject({ baseBranch: 'main' });
    expect(findSession(loadHistory(), 'shop', 'feat/g')?.baseBranches).toBeUndefined();
    await setSessionBase('shop', 'feat/g', { '/w/a': 'main', '/w/b': 'master' });
    expect(findSession(loadHistory(), 'shop', 'feat/g')).toMatchObject({ baseBranch: 'main', baseBranches: { '/w/a': 'main', '/w/b': 'master' } });
  });
});

describe('when the parent is archived (not only after the child’s next turn)', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const notes: string[] = [];
    return {
      notes,
      d: {
        history: loadHistory,
        config: () => ({ worktreesRoot: tmp, repos: { api: clone }, groups: {}, copyFiles: [] }),
        invalidate: () => {},
        startRun: () => ({ note: (t: string) => void notes.push(t), done: () => {} }),
        busy: new Set<string>(),
        shownState: () => 'idle' as const,
        tell: vi.fn(async () => {}),
        ...over,
      },
    };
  };
  const archivedParent = (tip: string) => {
    const parent: WorktreeSession = { target: 'api', branch: 'feat/p', isGroup: false, paths: [parentWt], createdAt: now, lastAccessedAt: now, archivedAt: now };
    saveHistory([parent, child()]);
    fs.mkdirSync(archiveDirFor(sessionIdFor(parent)), { recursive: true });
    writeArchiveRecord({
      sessionId: sessionIdFor(parent), target: 'api', branch: 'feat/p', isGroup: false, paths: [parentWt], archivedAt: now, worktreeRemoved: true, keptBecause: null, transcripts: [],
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [{ repo: 'api', number: 12, url: 'https://x/12', state: 'MERGED' }], jiraKey: null },
      tips: { api: tip },
    });
    return parent;
  };

  it('its children move onto main at once', async () => {
    const parent = archivedParent(squashMergeParent());
    const { d, notes } = deps();
    expect(await retargetChildrenOf(sessionIdFor(parent), d)).toBe(1);
    expect(notes[0]).toContain('feat/c: moved onto main (its parent merged and was archived)');
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).toBe('c1');
  });

  it('rewritten before it merged, branch gone: the child’s Claude is asked to do it — once', async () => {
    fs.writeFileSync(path.join(parentWt, 'p.txt'), 'p2 (reviewed)\n');
    git(parentWt, 'commit', '-q', '-a', '--amend', '-m', 'p2 reviewed');
    git(clone, 'merge', '-q', '--squash', 'feat/p');
    git(clone, 'commit', '-q', '-m', 'Parent work (#12)');
    git(clone, 'push', '-q', 'origin', 'main');
    const tip = git(parentWt, 'rev-parse', 'HEAD');
    git(clone, 'worktree', 'remove', '--force', parentWt);
    git(clone, 'branch', '-q', '-D', 'feat/p');
    const parent = archivedParent(tip);
    const { d, notes } = deps();
    expect(await retargetChildrenOf(sessionIdFor(parent), d)).toBe(0);
    expect(d.tell).toHaveBeenCalledWith(expect.anything(), ontoMainPrompt('feat/p'));
    expect(notes[0]).toContain('its Claude was asked to move this branch onto main');
    await retargetChildrenOf(sessionIdFor(parent), d);
    expect(d.tell).toHaveBeenCalledTimes(1); // asked once per parent tip
    // The button says so too, and offers to hand it over.
    const r = await retargetOntoMain(child(), async () => ({ branch: 'feat/p', tip }));
    expect(r.results[0]).toMatchObject({ ok: false, handOff: true, base: 'origin/main' });
  });

  it('turned off (stacks.autoUpdate: false): nothing', async () => {
    const parent = archivedParent(squashMergeParent());
    const { d } = deps({ config: () => ({ worktreesRoot: tmp, repos: { api: clone }, groups: {}, copyFiles: [], stacks: { autoUpdate: false } }) });
    expect(await retargetChildrenOf(sessionIdFor(parent), d)).toBe(0);
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).not.toBe('c1');
  });
});

describe('the merged parent, end to end (archive record → route → no longer stacked)', () => {
  function archive(p: WorktreeSession, tip: string, prState: string) {
    const rec: ArchiveRecord = {
      sessionId: sessionIdFor(p), target: p.target, branch: p.branch, isGroup: false, paths: p.paths, archivedAt: now,
      worktreeRemoved: true, keptBecause: null, transcripts: [],
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [{ repo: 'api', number: 12, url: 'https://x/12', state: prState }], jiraKey: null },
      tips: { api: tip },
    };
    fs.mkdirSync(archiveDirFor(rec.sessionId), { recursive: true });
    writeArchiveRecord(rec);
  }
  const setup = (prState = 'MERGED') => {
    saveConfig({ worktreesRoot: tmp, repos: { api: clone }, groups: {}, copyFiles: [] });
    const tip = squashMergeParent();
    const parent: WorktreeSession = { target: 'api', branch: 'feat/p', isGroup: false, paths: [parentWt], createdAt: now, lastAccessedAt: now, archivedAt: now };
    saveHistory([parent, child()]);
    archive(parent, tip, prState);
    const app = new Hono();
    mountUpdateRoutes(app, { broadcast: () => {} });
    return { app, retarget: () => app.request(`/api/sessions/${sessionIdFor(child())}/retarget`, { method: 'POST' }) };
  };

  it('Move onto main: from the tip the archive recorded; afterwards based on main, not stacked', async () => {
    const { retarget } = setup();
    expect(sessionStacks(loadHistory(), null).mergedParentOf.get(sessionIdFor(child()))?.branch).toBe('feat/p');
    const r = await retarget();
    expect(await r.json()).toMatchObject({ results: [{ ok: true, how: 'rebase', base: 'origin/main' }] });
    expect(findSession(loadHistory(), 'api', 'feat/c')?.baseBranch).toBe('main');
    expect(sessionStacks(loadHistory(), null).mergedParentOf.size).toBe(0);
    expect(git(childWt, 'log', '--format=%s', 'origin/main..HEAD')).toBe('c1');
  });

  it("an archived parent that didn't merge: not offered (its work would be dropped)", async () => {
    const { retarget } = setup('CLOSED');
    expect((await retarget()).status).toBe(409);
  });

  it("after the child's own turn it moves by itself, when clean, and its Claude is told", async () => {
    setup();
    const tell = vi.fn(async () => {});
    const notes: string[] = [];
    const n = await syncStacksAfterTurn(sessionIdFor(child()), {
      history: loadHistory,
      config: () => ({ worktreesRoot: tmp, repos: { api: clone }, groups: {}, copyFiles: [] }),
      invalidate: () => {},
      startRun: () => ({ note: (t: string) => void notes.push(t), done: () => {} }),
      busy: new Set(),
      shownState: () => 'idle',
      tell,
    });
    expect(n).toBe(1);
    expect(notes[0]).toContain('feat/c: moved onto main (feat/p merged); its Claude was told');
    expect(tell).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('has merged, so this branch was moved onto main'));
    expect(findSession(loadHistory(), 'api', 'feat/c')?.baseBranch).toBe('main');
  });
});
