import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { git } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { findSession, loadHistory } from '../../../src/core/sessions/history.js';
import {
  baseArgs,
  childArgs,
  createInChild,
  createInProcess,
  invalidRequest,
  oneAtATime,
  type CreateResult,
} from '../../../src/core/worktree/setup-child.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'bin.ts');

describe('the child run, as argv (pure)', () => {
  it('target, branch, --setup-only, each base, the Jira key and the name', () => {
    expect(baseArgs({ default: 'dev', perRepo: { web: 'feat/x' } })).toEqual(['--base=dev', '--base=web=feat/x']);
    expect(childArgs({ target: 'api', branch: 'feat/a', base: { perRepo: {} }, jiraKey: 'PAY-1', name: ' Retry ' })).toEqual([
      'tree',
      'api',
      'feat/a',
      '--setup-only',
      '--jira-key=PAY-1',
      '--name=Retry',
    ]);
    expect(childArgs({ target: 'api' })).toEqual(['tree', 'api', '--setup-only']); // the repo's own checkout
    // A new session's own repos (a fork of a session folder).
    expect(childArgs({ target: 'shop', branch: 'feat/a', repos: ['api', 'web'] })).toEqual([
      'tree',
      'shop',
      'feat/a',
      '--setup-only',
      '--repos=api,web',
    ]);
  });

  it("what the child's command line would misread as a flag is refused before anything runs", () => {
    expect(invalidRequest({ target: 'api', branch: '--unsafe' })).toMatch(/not a valid branch name/);
    expect(invalidRequest({ target: '-x' })).toMatch(/not a project/);
    expect(invalidRequest({ target: 'api', branch: 'b', base: { default: '--x', perRepo: {} } })).toMatch(/not a valid base/);
    expect(invalidRequest({ target: 'api', branch: 'feat/a', name: '--unsafe' })).toBeNull(); // a name is a value (--name=…)
    expect(invalidRequest({ target: 'api', branch: 'b', repos: ['api', '--x'] })).toMatch(/not a repo/);
    expect(invalidRequest({ target: 'api', branch: 'b', repos: ['a,b'] })).toMatch(/not a repo/);
    expect(invalidRequest({ target: 'api', branch: 'b', repos: ['api', 'web'] })).toBeNull();
  });
});

describe('oneAtATime', () => {
  it('creations in one project run one after another; the same one asked twice gets one answer; other projects go at once', async () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const fake = vi.fn((req: { target: string; branch?: string }) => {
      order.push(`start ${req.target}/${req.branch}`);
      return new Promise<CreateResult>((resolve) =>
        gates.set(`${req.target}/${req.branch}`, () => resolve({ ok: true, branch: req.branch ?? '', launchDir: '', paths: [] })),
      );
    });
    const create = oneAtATime(fake);
    const cfg = {} as WorkConfig;
    const a1 = create({ target: 'api', branch: 'a' }, cfg);
    const a1again = create({ target: 'api', branch: 'a' }, cfg);
    const a2 = create({ target: 'api', branch: 'b' }, cfg);
    const w = create({ target: 'web', branch: 'c' }, cfg);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start api/a', 'start web/c']); // api/b waits for api/a
    expect(a1again).toBe(a1);
    gates.get('api/a')!();
    await a1;
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start api/a', 'start web/c', 'start api/b']);
    gates.get('api/b')!();
    gates.get('web/c')!();
    await Promise.all([a2, w]);
    expect(fake).toHaveBeenCalledTimes(3);
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
    const web = path.join(project, 'web');
    fs.mkdirSync(web);
    git(['init', '-b', 'main'], web);
    git(['config', 'user.email', 't@t.t'], web);
    git(['config', 'user.name', 'T'], web);
    fs.writeFileSync(path.join(web, 'w.txt'), 'w');
    git(['add', '.'], web);
    git(['commit', '-m', 'init', '--no-gpg-sign'], web);
    config = { worktreesRoot: path.join(project, 'wt'), repos: { api: repo, web }, groups: {}, copyFiles: [] };
    saveConfig(config); // the child reads it from the same (test) HOME
  });
  afterAll(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const create = createInChild(BIN, { execArgv: ['--import', 'tsx'], timeoutMs: 120_000 });

  it("makes the worktree and its session, answering as in-process creation does — and the server's loop keeps turning meanwhile", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 20);
    // A name that looks like a flag is still the name (passed as --name=…).
    const r = await create({ target: 'api', branch: 'feat/a', name: '--unsafe' }, config);
    clearInterval(tick);
    expect(r).toMatchObject({ ok: true, branch: 'feat/a', paths: [path.join(config.worktreesRoot, 'api', 'feat-a')] });
    expect(fs.existsSync(path.join(config.worktreesRoot, 'api', 'feat-a', 'a.txt'))).toBe(true);
    expect(findSession(loadHistory(), 'api', 'feat/a')?.title).toBe('--unsafe');
    expect(ticks).toBeGreaterThan(5); // nothing here waited on git
  }, 150_000);

  it("a new session's own repos (--repos): made as a session folder holding them", async () => {
    const r = await create({ target: 'api', branch: 'feat/r', repos: ['api', 'web'] }, config);
    const folder = path.join(config.worktreesRoot, 'api', 'feat-r');
    expect(r).toMatchObject({ ok: true, launchDir: folder, paths: [path.join(folder, 'api'), path.join(folder, 'web')] });
    expect(findSession(loadHistory(), 'api', 'feat/r')).toMatchObject({ isGroup: true, repos: ['api', 'web'] });
    const unknown = await createInProcess({ target: 'api', branch: 'feat/s', repos: ['api', 'nope'] }, config);
    expect(unknown).toEqual({ ok: false, error: expect.stringContaining('not in your config: nope') });
  }, 150_000);

  it("the repo's own checkout with no branch; a failure says why (the child's own error)", async () => {
    expect(await create({ target: 'api' }, config)).toMatchObject({ ok: true, branch: 'main', paths: [config.repos.api] });
    const bad = await create({ target: 'nope', branch: 'feat/b' }, config);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/nope/);
    expect(await createInProcess({ target: 'nope', branch: 'feat/b' }, config)).toMatchObject({ ok: false });
    // A branch that would be read as a flag: refused, no run, no base checkout opened instead.
    expect(await create({ target: 'api', branch: '--unsafe' }, config)).toEqual({
      ok: false,
      error: expect.stringContaining('not a valid branch name'),
    });
  }, 150_000);
});
