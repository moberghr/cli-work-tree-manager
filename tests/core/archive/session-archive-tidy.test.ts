import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveWaiting, defaultArchiveDeps } from '../../../src/core/archive/session-archive-deps.js';
import { recreateArchivedBranches, setupWorktree } from '../../../src/core/worktree/worktree.js';
import { loadHistory, saveHistory, setSessionArchived, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { rememberSent, saveDraft } from '../../../src/core/pr/pr-replies.js';
import { recordStatusEvent } from '../../../src/core/status/session-status.js';
import { archiveSession } from '../../../src/core/archive/session-archive.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let home: string;
let repo: string;
let config: WorkConfig;
const session = (branch: string): WorktreeSession => ({
  target: 'api',
  branch,
  isGroup: false,
  paths: [path.join(home, 'wt', branch.replace('/', '-'))],
  createdAt: 'x',
  lastAccessedAt: 'x',
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-deps-'));
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const origin = path.join(home, 'origin.git');
  repo = path.join(home, 'repo');
  git(home, 'init', '-q', '--bare', '-b', 'main', origin);
  git(home, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a'), 'a');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-q', '-m', 'a');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // feat/merged: merged into main and pushed. feat/squashed: not in main.
  for (const [b, merge] of [
    ['feat/merged', true],
    ['feat/squashed', false],
  ] as const) {
    git(repo, 'checkout', '-q', '-b', b, 'main');
    fs.writeFileSync(path.join(repo, b.replace('/', '-')), b);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', b);
    git(repo, 'checkout', '-q', 'main');
    if (merge) {
      git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${b}`, b);
      git(repo, 'push', '-q', 'origin', 'main');
    }
  }
  config = { worktreesRoot: path.join(home, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] } as WorkConfig;
  saveConfig(config);
  saveHistory([session('feat/merged'), session('feat/squashed')]);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('archive deps (real git)', () => {
  it('records the tip; tidy deletes a branch already in main, keeps a squash-merged one', async () => {
    const d = defaultArchiveDeps();
    const tip = git(repo, 'rev-parse', 'feat/merged');
    expect(await d.tips!(session('feat/merged'), {})).toEqual({ api: tip });
    expect(await d.tidy!(session('feat/merged'), {})).toEqual(['api']);
    expect(git(repo, 'branch', '--list', 'feat/merged')).toBe('');
    expect(await d.tidy!(session('feat/squashed'), {})).toEqual([]);
    expect(git(repo, 'branch', '--list', 'feat/squashed')).toContain('feat/squashed');
  });

  it('Restore recreates a branch archiving deleted, at its recorded tip — not when a branch of that name exists', async () => {
    const tip = git(repo, 'rev-parse', 'feat/merged');
    const id = sessionIdFor(session('feat/merged'));
    fs.mkdirSync(path.join(home, '.work', 'archive', id), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.work', 'archive', id, 'archive.json'),
      JSON.stringify({
        sessionId: id,
        target: 'api',
        branch: 'feat/merged',
        isGroup: false,
        paths: [],
        archivedAt: 'x',
        worktreeRemoved: true,
        keptBecause: null,
        transcripts: [],
        summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
        tips: { api: tip },
        branchesDeleted: ['api'],
      }),
    );
    git(repo, 'branch', '-D', 'feat/merged');
    expect(recreateArchivedBranches('api', 'feat/merged', ['api'], config)).toEqual(['api']);
    expect(git(repo, 'rev-parse', 'feat/merged')).toBe(tip);
    expect(recreateArchivedBranches('api', 'feat/merged', ['api'], config)).toEqual([]); // there now: left alone
  });

  // A session started on feat/start whose Claude then switched its worktree to feat/merged.
  const switched = () => {
    const wt = path.join(home, 'wt', 'repo', 'feat-start');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/start', 'main');
    git(wt, 'checkout', '-q', 'feat/merged');
    const s: WorktreeSession = { target: 'api', branch: 'feat/start', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
    saveHistory([...loadHistory(), s]);
    return { s, wt };
  };

  it('archiving a worktree on another branch records that branch, its tip, and tidies it too', async () => {
    const { s, wt } = switched();
    const d = defaultArchiveDeps();
    const heads = d.heads!(s);
    expect(heads).toEqual({ api: 'feat/merged' });
    expect(await d.tips!(s, heads)).toEqual({ api: git(repo, 'rev-parse', 'feat/merged') });
    git(repo, 'worktree', 'remove', wt);
    expect(await d.tidy!(s, heads)).toEqual(['api']); // the checked-out one went (reported), and the session's
    expect(git(repo, 'branch', '--list', 'feat/merged', 'feat/start')).toBe('');
  });

  it('Restore brings a removed worktree back on the branch it was on, at its tip, in the session’s folder', async () => {
    const { s, wt } = switched();
    const tip = git(repo, 'rev-parse', 'feat/merged');
    const id = sessionIdFor(s);
    fs.mkdirSync(path.join(home, '.work', 'archive', id), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.work', 'archive', id, 'archive.json'),
      JSON.stringify({
        sessionId: id,
        target: 'api',
        branch: 'feat/start',
        isGroup: false,
        paths: [wt],
        archivedAt: 'x',
        worktreeRemoved: true,
        keptBecause: null,
        transcripts: [],
        summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
        tips: { api: tip },
        heads: { api: 'feat/merged' },
        branchesDeleted: ['api'],
      }),
    );
    git(repo, 'worktree', 'remove', wt);
    git(repo, 'branch', '-D', 'feat/merged');
    await setSessionArchived('api', 'feat/start', true);
    const r = await setupWorktree('api', 'feat/start', config, undefined, undefined, { pull: false });
    expect(r?.paths).toEqual([wt]);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/merged');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('re-entering a kept worktree that is on another branch uses it as it is (git worktree add into it failed)', async () => {
    const { wt } = switched();
    const r = await setupWorktree('api', 'feat/start', config, undefined, undefined, { pull: false });
    expect(r?.paths).toEqual([wt]);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/merged');
  });

  describe('uncommitted work through a real archive and Restore (end to end)', () => {
    const deps = () => ({ ...defaultArchiveDeps(), stopClaude: async () => {}, transcripts: () => [] });

    it('merged + dirty: saved, the worktree removed, and Restore puts the files back', async () => {
      const made = await setupWorktree('api', 'feat/merged', config, undefined, undefined, { pull: false });
      const wt = made!.paths[0];
      fs.writeFileSync(path.join(wt, 'a'), 'edited');
      fs.writeFileSync(path.join(wt, 'Harness.cs'), 'class Harness {}');
      const s = loadHistory().find((x) => x.branch === 'feat/merged' && x.paths[0] === wt)!;

      const out = await archiveSession(s, deps(), { merged: true });
      expect(out).toMatchObject({
        ok: true,
        worktreeRemoved: true,
        message: expect.stringContaining('2 uncommitted files saved for Restore'),
      });
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(repo, 'for-each-ref', 'refs/work/archive/')).toContain(sessionIdFor(s));

      await setupWorktree('api', 'feat/merged', config, undefined, undefined, { pull: false });
      expect(fs.readFileSync(path.join(wt, 'a'), 'utf8')).toBe('edited');
      expect(fs.readFileSync(path.join(wt, 'Harness.cs'), 'utf8')).toBe('class Harness {}');
      expect(git(wt, 'diff', '--cached', '--name-only')).toBe(''); // back unstaged
      expect(git(repo, 'for-each-ref', 'refs/work/archive/')).toBe(''); // the ref went once they were back
    });

    // Two real repos through archive and Restore: ~9 s alone, past the default 20 s under a full parallel run.
    it('a group: each repo’s changes saved on its own, and each put back in its own folder', async () => {
      // A second repo, `web`, with feat/merged merged into its main too.
      const webOrigin = path.join(home, 'web.git');
      const web = path.join(home, 'web');
      git(home, 'init', '-q', '--bare', '-b', 'main', webOrigin);
      git(home, 'clone', '-q', webOrigin, web);
      fs.writeFileSync(path.join(web, 'w'), 'w');
      git(web, 'add', 'w');
      git(web, 'commit', '-q', '-m', 'w');
      git(web, 'push', '-q', '-u', 'origin', 'main');
      git(web, 'remote', 'set-head', 'origin', 'main');
      git(web, 'checkout', '-q', '-b', 'feat/merged');
      fs.writeFileSync(path.join(web, 'page'), 'page');
      git(web, 'add', '.');
      git(web, 'commit', '-q', '-m', 'page');
      git(web, 'checkout', '-q', 'main');
      git(web, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/merged');
      git(web, 'push', '-q', 'origin', 'main');
      const group = { ...config, repos: { api: repo, web }, groups: { shop: ['api', 'web'] } } as WorkConfig;
      saveConfig(group);

      // The group's combined instructions file, as `work config group` keeps it.
      fs.writeFileSync(path.join(home, '.work', 'shop.claude.md'), '# shop');
      const made = await setupWorktree('shop', 'feat/merged', group, undefined, undefined, { pull: false });
      const [apiWt, webWt] = ['repo', 'web'].map((n) => made!.paths.find((p) => path.basename(p) === n)!);
      // In the group root under the name its agent reads (Claude: CLAUDE.md).
      expect(fs.readFileSync(path.join(path.dirname(apiWt), 'CLAUDE.md'), 'utf8')).toBe('# shop');
      fs.writeFileSync(path.join(apiWt, 'a'), 'api edit');
      fs.writeFileSync(path.join(webWt, 'w'), 'web edit');
      fs.writeFileSync(path.join(webWt, 'new.css'), 'body {}');
      const s = loadHistory().find((x) => x.target === 'shop')!;

      const out = await archiveSession(s, deps(), { merged: true });
      expect(out).toMatchObject({ ok: true, worktreeRemoved: true, message: expect.stringContaining('3 uncommitted files saved') });
      expect(fs.existsSync(path.join(path.dirname(apiWt), 'CLAUDE.md'))).toBe(false); // gone with the worktree
      const rec = (await import('../../../src/core/archive/session-archive.js')).readArchive(sessionIdFor(s));
      expect(Object.keys(rec!.uncommitted!).sort()).toEqual(['api', 'web']);

      await setupWorktree('shop', 'feat/merged', group, undefined, undefined, { pull: false });
      expect(fs.readFileSync(path.join(apiWt, 'a'), 'utf8')).toBe('api edit');
      expect(fs.readFileSync(path.join(webWt, 'w'), 'utf8')).toBe('web edit');
      expect(fs.readFileSync(path.join(webWt, 'new.css'), 'utf8')).toBe('body {}');
      expect(fs.existsSync(path.join(apiWt, 'new.css'))).toBe(false); // not mixed up between repos
    }, 60_000);

    it('commits not in main still keep the worktree: nothing saved, nothing left behind', async () => {
      const made = await setupWorktree('api', 'feat/squashed', config, undefined, undefined, { pull: false });
      const wt = made!.paths[0];
      fs.writeFileSync(path.join(wt, 'a'), 'edited');
      const s = loadHistory().find((x) => x.branch === 'feat/squashed' && x.paths[0] === wt)!;
      const out = await archiveSession(s, deps(), { merged: true });
      expect(out).toMatchObject({
        ok: true,
        worktreeRemoved: false,
        keptBecause: expect.stringContaining('commits not in the main branch'),
      });
      expect(fs.readFileSync(path.join(wt, 'a'), 'utf8')).toBe('edited');
      expect(git(repo, 'for-each-ref', 'refs/work/archive/')).toBe('');
    });
  });

  it('says what would be left unfinished', async () => {
    const id = sessionIdFor(session('feat/merged'));
    expect(archiveWaiting(id)).toEqual([]);
    rememberSent(id, [{ threadId: 'PRRT_abcdef', repo: 'api', prNumber: 1, url: 'u', where: null, reviewer: 'r', excerpt: 'e' }]);
    saveDraft(id, 'PRRT_abcdef', 'Fixed');
    await recordStatusEvent(id, { kind: 'prompt' });
    expect(archiveWaiting(id)).toEqual(['1 reply to post on review threads', 'its Claude is working']);
  });
});
