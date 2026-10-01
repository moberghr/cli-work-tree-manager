import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git } from '../../src/core/git.js';
import { saveConfig, type WorkConfig } from '../../src/core/config.js';
import { findSession, loadHistory } from '../../src/core/history.js';
import { baseArgs, childArgs, createInChild, createInProcess } from '../../src/core/setup-child.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bin.ts');

describe('the child run, as argv (pure)', () => {
  it('target, branch, --setup-only, each base, the Jira key and the name', () => {
    expect(baseArgs({ default: 'dev', perRepo: { web: 'feat/x' } })).toEqual(['--base', 'dev', '--base', 'web=feat/x']);
    expect(childArgs({ target: 'api', branch: 'feat/a', base: { perRepo: {} }, jiraKey: 'PAY-1', name: ' Retry ' })).toEqual([
      'tree', 'api', 'feat/a', '--setup-only', '--jira-key', 'PAY-1', '--name', 'Retry',
    ]);
    expect(childArgs({ target: 'api' })).toEqual(['tree', 'api', '--setup-only']); // the repo's own checkout
  });
});

describe('createInChild (a real `work tree --setup-only`, under tsx)', () => {
  let project: string;
  let config: WorkConfig;
  beforeAll(() => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-child-')));
    const repo = path.join(project, 'api');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 'T'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
    config = { worktreesRoot: path.join(project, 'wt'), repos: { api: repo }, groups: {}, copyFiles: [] };
    saveConfig(config); // the child reads it from the same (test) HOME
  });
  afterAll(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const create = createInChild(BIN, { execArgv: ['--import', 'tsx'], timeoutMs: 120_000 });

  it("makes the worktree and its session, answering as in-process creation does — and the server's loop keeps turning meanwhile", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 20);
    const r = await create({ target: 'api', branch: 'feat/a', name: 'Child made' }, config);
    clearInterval(tick);
    expect(r).toMatchObject({ ok: true, branch: 'feat/a', paths: [path.join(config.worktreesRoot, 'api', 'feat-a')] });
    expect(fs.existsSync(path.join(config.worktreesRoot, 'api', 'feat-a', 'a.txt'))).toBe(true);
    expect(findSession(loadHistory(), 'api', 'feat/a')?.title).toBe('Child made');
    expect(ticks).toBeGreaterThan(5); // nothing here waited on git
  }, 150_000);

  it("the repo's own checkout with no branch; a failure says why (the child's own error)", async () => {
    expect(await create({ target: 'api' }, config)).toMatchObject({ ok: true, branch: 'main', paths: [config.repos.api] });
    const bad = await create({ target: 'nope', branch: 'feat/b' }, config);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/nope/);
    expect(await createInProcess({ target: 'nope', branch: 'feat/b' }, config)).toMatchObject({ ok: false });
  }, 150_000);
});
