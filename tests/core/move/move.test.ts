import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  exportBundle,
  importBundle,
  MoveError,
  readManifest,
  remapPath,
  remapRules,
  remapSession,
  unsavedWork,
} from '../../../src/core/move/move.js';
import { saveConfig, loadConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { loadHistory, saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { claudeProjectsRoot, encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { withDb } from '../../../src/core/platform/db.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('paths on the new computer', () => {
  const m = {
    from: { home: 'C:\\Users\\ana', platform: 'win32', worktreesRoot: 'C:\\Users\\ana\\source\\worktrees' },
    repos: { api: { path: 'C:\\Users\\ana\\source\\repos\\api', origin: null }, web: { path: 'D:\\code\\web', origin: null } },
  };
  const join = path.win32.join;

  it('the same places under the new home by default; any case and slash of the old one', () => {
    const rules = remapRules(m, {}, 'C:\\Users\\domagoj', join);
    const move = (p: string) => remapPath(p, rules, true, join);
    expect(move('C:\\Users\\ana\\source\\repos\\api')).toBe('C:\\Users\\domagoj\\source\\repos\\api');
    expect(move('c:/users/ANA/source/worktrees/api/feat-x')).toBe('C:\\Users\\domagoj\\source\\worktrees\\api\\feat-x');
    // Outside the old home: stays where it was.
    expect(move('D:\\code\\web')).toBe('D:\\code\\web');
    // Only a whole folder name matches.
    expect(move('C:\\Users\\anabel\\x')).toBe('C:\\Users\\anabel\\x');
  });

  it('--repos-root and --worktrees-root put them where you say, each repo in its folder name', () => {
    const rules = remapRules(m, { reposRoot: 'E:\\repos', worktreesRoot: 'E:\\wt' }, 'C:\\Users\\domagoj', join);
    const move = (p: string) => remapPath(p, rules, true, join);
    expect(move('D:\\code\\web')).toBe('E:\\repos\\web');
    expect(move('C:\\Users\\ana\\source\\repos\\api')).toBe('E:\\repos\\api');
    expect(move('C:\\Users\\ana\\source\\worktrees\\shop\\feat-x\\backend')).toBe('E:\\wt\\shop\\feat-x\\backend');
  });

  it('a session moves its paths and its per-repo bases (keyed by path)', () => {
    const s = {
      target: 'shop',
      branch: 'b',
      isGroup: true,
      paths: ['/a/x'],
      baseBranches: { '/a/x': 'dev' },
    } as unknown as WorktreeSession;
    expect(remapSession(s, (p) => p.replace('/a', '/b'))).toMatchObject({ paths: ['/b/x'], baseBranches: { '/b/x': 'dev' } });
  });
});

describe('moving to another computer (real git, two homes)', () => {
  let root: string;
  let oldHome: string;
  let newHome: string;
  let bundle: string;
  let origin: string;
  let session: WorktreeSession;
  let wt: string;
  let home: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-'));
    oldHome = path.join(root, 'old');
    newHome = path.join(root, 'new');
    bundle = path.join(root, 'bundle');
    origin = path.join(root, 'origin.git');
    fs.mkdirSync(path.join(oldHome, '.work'), { recursive: true });
    fs.mkdirSync(newHome, { recursive: true });
    home = vi.spyOn(os, 'homedir').mockReturnValue(oldHome);

    const repo = path.join(oldHome, 'src', 'api');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, repo);
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    git(repo, 'add', 'a');
    git(repo, 'commit', '-q', '-m', 'a');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    const config = { worktreesRoot: path.join(oldHome, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] } as WorkConfig;
    saveConfig(config);
    saveHistory([]);
    const made = await setupWorktree('api', 'feat/x', config);
    wt = made!.paths[0];
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'the feature');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'feature');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/x');
    session = loadHistory().find((s) => s.branch === 'feat/x')!;
    // Its conversation, where Claude keeps it, and work's own copy.
    const projects = path.join(claudeProjectsRoot(), encodeProjectDir(wt));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'conv.jsonl'), '{"type":"user","message":{"content":"build it"}}\n');
    fs.mkdirSync(path.join(oldHome, '.work', 'conversations', sessionIdFor(session)), { recursive: true });
    fs.writeFileSync(path.join(oldHome, '.work', 'conversations', sessionIdFor(session), 'conv.jsonl'), 'copy\n');
  }, 120_000); // real git: repos, a clone, a worktree, pushes — slow on a CI runner
  afterAll(() => {
    home.mockRestore();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('export first says what is only on this computer: uncommitted files, commits not pushed', async () => {
    expect(await unsavedWork(loadHistory())).toEqual([]);
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
    expect((await unsavedWork(loadHistory())).map((u) => u.what)).toEqual(['1 uncommitted file']);
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'local only');
    expect((await unsavedWork(loadHistory())).map((u) => u.what)).toEqual(['1 commit not pushed']);
    git(wt, 'push', '-q');
    expect(await unsavedWork(loadHistory())).toEqual([]);
  });

  it('exports a bundle: database, config, conversations, transcripts, and each repo with its origin', () => {
    const r = exportBundle(bundle);
    expect(r).toMatchObject({ sessions: 1, transcripts: 1 });
    const m = readManifest(bundle);
    expect(m.repos.api).toEqual({ path: path.join(oldHome, 'src', 'api'), origin });
    expect(m.from.home).toBe(oldHome);
    expect(fs.existsSync(path.join(bundle, 'transcripts', sessionIdFor(session), 'conv.jsonl'))).toBe(true);
    expect(() => exportBundle(bundle)).toThrow(MoveError);
  });

  it('imports it on the other computer: repo cloned, worktree back from origin, conversation where Claude looks', async () => {
    home.mockReturnValue(newHome);
    const r = await importBundle(bundle, { clone: true });
    expect(r.repos).toEqual({ cloned: ['api'], missing: [] });
    expect(r.worktrees).toEqual({ created: ['api · feat/x'], failed: [] });
    expect(r.transcripts).toBe(1);

    const config = loadConfig()!;
    expect(config.repos.api).toBe(path.join(newHome, 'src', 'api'));
    expect(config.worktreesRoot).toBe(path.join(newHome, 'wt'));
    const s = loadHistory().find((x) => x.branch === 'feat/x')!;
    expect(s.paths[0].startsWith(newHome)).toBe(true);
    expect(fs.readFileSync(path.join(s.paths[0], 'feature.txt'), 'utf8')).toBe('the feature');
    expect(fs.existsSync(path.join(claudeProjectsRoot(), encodeProjectDir(s.paths[0]), 'conv.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(newHome, '.work', 'conversations', sessionIdFor(s), 'conv.jsonl'))).toBe(true);
    expect(withDb((d) => (d.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n)).toBe(0);
  }, 120_000);

  it('refuses to import over sessions already here, unless forced; a folder that is no bundle says so', async () => {
    await expect(importBundle(bundle)).rejects.toThrow(/sessions already/);
    expect(() => readManifest(root)).toThrow(/isn't a work bundle/);
  });
});
