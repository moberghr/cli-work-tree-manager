import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliasFromFolder,
  enrollProblem,
  groupProblem,
  originUrl,
  ownerRepo,
  readGitConfig,
  samePathKey,
  scanForRepos,
  suggestAlias,
} from '../../../src/core/worktree/repo-scan.js';

let root: string;
const mk = (rel: string) => fs.mkdirSync(path.join(root, rel), { recursive: true });
const repo = (rel: string, origin?: string) => {
  mk(`${rel}/.git`);
  if (origin)
    fs.writeFileSync(
      path.join(root, rel, '.git', 'config'),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*\n`,
    );
};

beforeAll(() => {
  // Built once: a folder like source\\repos.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scan-'));
  repo('api', 'https://github.com/moberghr/api.git');
  repo('web', 'git@github.com:moberghr/web.git');
  repo('iom/contracts'); // two levels down
  repo('api/nested'); // inside a repo: the repo's business
  mk('deep/a/b');
  repo('deep/a/b/too-deep');
  mk('linked');
  fs.writeFileSync(path.join(root, 'linked', '.git'), 'gitdir: C:/x/.git/worktrees/linked\n'); // a worktree, not a repo
  repo('worktrees/api/feat-x'); // work's own worktrees: never scanned
  repo('node_modules/pkg'); // build output
  repo('.hidden/x');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('scanForRepos', () => {
  it('finds repos two levels down, stopping at each, skipping build output, dot-folders, linked .git files and the worktrees root', () => {
    const found = scanForRepos(root, { skip: [path.join(root, 'worktrees')] });
    expect(found.map((f) => path.relative(root, f.path).replace(/\\/g, '/'))).toEqual(['api', 'iom/contracts', 'web']);
    expect(found.find((f) => f.folder === 'api')?.origin).toBe('moberghr/api');
    expect(found.find((f) => f.folder === 'web')?.origin).toBe('moberghr/web');
    expect(found.find((f) => f.folder === 'contracts')?.origin).toBeNull();
  });

  it('deeper when asked; nothing for a folder that is not there', () => {
    expect(scanForRepos(root, { depth: 4, skip: [path.join(root, 'worktrees')] }).map((f) => f.folder)).toContain('too-deep');
    expect(scanForRepos(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('origins and paths', () => {
  it('reads owner/name from https and ssh origins', () => {
    expect(ownerRepo('https://github.com/hangfire/Hangfire.git')).toBe('hangfire/Hangfire');
    expect(ownerRepo('git@github.com:moberghr/work-tree.git')).toBe('moberghr/work-tree');
    expect(originUrl('[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = b\n')).toBe('b');
    expect(originUrl('[core]\n')).toBeNull();
    // As git writes a Windows path: backslashes escaped, maybe quoted.
    expect(
      originUrl(String.raw`[remote "origin"]
	url = C:\\x\\o.git`),
    ).toBe(String.raw`C:\x\o.git`);
    expect(
      originUrl(String.raw`[remote "origin"]
	url = "C:\\my repos\\o.git"`),
    ).toBe(String.raw`C:\my repos\o.git`);
  });

  it("readGitConfig: a repo's .git/config, a linked worktree's common config through gitdir + commondir, a submodule's own", () => {
    expect(readGitConfig(path.join(root, 'api'))).toContain('moberghr/api');
    expect(readGitConfig(path.join(root, 'iom/contracts'))).toBeNull(); // no config file
    expect(readGitConfig(path.join(root, 'nope'))).toBeNull();
    // A worktree of api: its .git file points into api/.git/worktrees/wt, whose commondir is ../..
    const wtGit = path.join(root, 'api', '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    mk('wt-of-api');
    fs.writeFileSync(path.join(root, 'wt-of-api', '.git'), `gitdir: ${wtGit}\n`);
    expect(readGitConfig(path.join(root, 'wt-of-api'))).toContain('moberghr/api');
    // A submodule: its gitdir holds its own config (no commondir), and a relative gitdir is the folder's.
    mk('web/.git/modules/sub');
    fs.writeFileSync(path.join(root, 'web/.git/modules/sub/config'), '[remote "origin"]\n\turl = git@github.com:moberghr/sub.git\n');
    mk('web/sub');
    fs.writeFileSync(path.join(root, 'web/sub/.git'), 'gitdir: ../.git/modules/sub\n');
    expect(readGitConfig(path.join(root, 'web/sub'))).toContain('moberghr/sub');
  });

  it('one key for a path however it is written (case only on Windows)', () => {
    expect(samePathKey('C:\\Repos\\Jobly\\', 'win32')).toBe(samePathKey('c:/repos/jobly', 'win32'));
    expect(samePathKey('/a/B', 'linux')).not.toBe(samePathKey('/a/b', 'linux'));
  });
});

describe('aliases', () => {
  const config = { repos: { 'acme-backend': '/r/acme-backend-ai', api: '/r/api' }, groups: { shop: ['api', 'acme-backend'] } };
  const taken = (a: string) => a in config.repos || a in config.groups;

  it('a folder name, made safe; taken → its parent in front, then -2', () => {
    expect(aliasFromFolder('EFCore.BulkExtensions')).toBe('efcore.bulkextensions');
    expect(aliasFromFolder('My Repo!')).toBe('my-repo');
    expect(suggestAlias('/r/acme-backend', taken)).toBe('r-acme-backend');
    expect(suggestAlias('/r/iom/contracts', taken)).toBe('contracts');
  });

  it('refuses a taken alias, a group name, a folder already enrolled, or a folder name another repo has', () => {
    expect(enrollProblem('api', '/r/other', config)).toMatch(/already the alias/);
    expect(enrollProblem('shop', '/r/shop2', config)).toMatch(/is a group/);
    expect(enrollProblem('api2', '/r/api', config)).toMatch(/already enrolled as “api”/);
    expect(enrollProblem('api2', '/elsewhere/API', config)).toMatch(/folder name/);
    expect(enrollProblem('Bad Alias', '/r/x', config)).toMatch(/lowercase/);
    expect(enrollProblem('fresh', '/r/fresh', config)).toBeNull();
  });

  it('groups: a free, valid name (when made), two enrolled repos or more', () => {
    expect(groupProblem('shop', ['api', 'acme-backend'], config, { creating: true })).toMatch(/already exists/);
    expect(groupProblem('api', ['api', 'acme-backend'], config, { creating: true })).toMatch(/alias/);
    expect(groupProblem('pair', ['api'], config, { creating: true })).toMatch(/at least two/);
    expect(groupProblem('pair', ['api', 'ghost'], config, { creating: true })).toMatch(/not enrolled: ghost/);
    expect(groupProblem('pair', ['api', 'acme-backend'], config, { creating: true })).toBeNull();
    // An existing group keeps its name; only its repos are checked.
    expect(groupProblem('shop', ['api', 'acme-backend'], config, { creating: false })).toBeNull();
  });
});
