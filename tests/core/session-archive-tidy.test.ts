import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveWaiting, defaultArchiveDeps } from '../../src/core/session-archive-deps.js';
import { recreateArchivedBranches } from '../../src/core/worktree.js';
import { saveHistory, type WorktreeSession } from '../../src/core/history.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { rememberSent, saveDraft } from '../../src/core/pr-replies.js';
import { recordStatusEvent } from '../../src/core/session-status.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let home: string;
let repo: string;
let config: WorkConfig;
const session = (branch: string): WorktreeSession => ({ target: 'api', branch, isGroup: false, paths: [path.join(home, 'wt', branch.replace('/', '-'))], createdAt: 'x', lastAccessedAt: 'x' });

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
  for (const [b, merge] of [['feat/merged', true], ['feat/squashed', false]] as const) {
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
    expect(await d.tips!(session('feat/merged'))).toEqual({ api: tip });
    expect(await d.tidy!(session('feat/merged'))).toEqual(['api']);
    expect(git(repo, 'branch', '--list', 'feat/merged')).toBe('');
    expect(await d.tidy!(session('feat/squashed'))).toEqual([]);
    expect(git(repo, 'branch', '--list', 'feat/squashed')).toContain('feat/squashed');
  });

  it('Restore recreates a branch archiving deleted, at its recorded tip — not when a branch of that name exists', async () => {
    const tip = git(repo, 'rev-parse', 'feat/merged');
    const id = sessionIdFor(session('feat/merged'));
    fs.mkdirSync(path.join(home, '.work', 'archive', id), { recursive: true });
    fs.writeFileSync(path.join(home, '.work', 'archive', id, 'archive.json'), JSON.stringify({
      sessionId: id, target: 'api', branch: 'feat/merged', isGroup: false, paths: [], archivedAt: 'x', worktreeRemoved: true, keptBecause: null,
      transcripts: [], summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
      tips: { api: tip }, branchesDeleted: ['api'],
    }));
    git(repo, 'branch', '-D', 'feat/merged');
    expect(recreateArchivedBranches('api', 'feat/merged', ['api'], config)).toEqual(['api']);
    expect(git(repo, 'rev-parse', 'feat/merged')).toBe(tip);
    expect(recreateArchivedBranches('api', 'feat/merged', ['api'], config)).toEqual([]); // there now: left alone
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
