import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, getCurrentBranch, parseWorktreeList } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree, teardownWorktree } from '../../../src/core/worktree/worktree.js';
import { findSession, loadHistory, saveHistory } from '../../../src/core/sessions/history.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';

/**
 * A group session owns its repo list (WorktreeSession.repos): re-entering and
 * tearing it down act over exactly its repos — one its group's config no
 * longer names included. A row from before (no repos) acts as it always did.
 */

let fixture: string;
let tmp: string;
let config: WorkConfig;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'own-repos-fixture-'));
  for (const name of ['api', 'web', 'docs']) {
    const dir = path.join(fixture, name);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  }
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-repos-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  fs.cpSync(fixture, path.join(tmp, 'src'), { recursive: true });
  const repo = (n: string) => path.join(tmp, 'src', n);
  config = {
    worktreesRoot: path.join(tmp, 'worktrees'),
    repos: { api: repo('api'), web: repo('web'), docs: repo('docs') },
    groups: { shop: ['api', 'web', 'docs'] },
    copyFiles: [],
  };
  saveConfig(config);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A shop session over api, web and docs — then the group's config loses docs. */
async function sessionWithDocsOutsideItsGroup() {
  const made = await setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false });
  expect(made?.paths).toHaveLength(3);
  config = { ...config, groups: { shop: ['api', 'web'] } };
  saveConfig(config);
  return made!.paths;
}
const listed = (repo: string, wt: string) =>
  parseWorktreeList(repo).some((w) => path.resolve(w.path).toLowerCase() === path.resolve(wt).toLowerCase());

describe("a group session's own repos", () => {
  it('are recorded when it is made, in the order of its paths', async () => {
    const made = await setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false });
    expect(findSession(loadHistory(), 'shop', 'feat/x')).toMatchObject({ paths: made!.paths, repos: ['api', 'web', 'docs'] });
    await setupWorktree('api', 'feat/solo', config, undefined, undefined, { pull: false });
    expect(findSession(loadHistory(), 'api', 'feat/solo')?.repos).toEqual(['api']);
  }, 60_000);

  it('re-entering keeps all three, though the group config names two', async () => {
    const paths = await sessionWithDocsOutsideItsGroup();
    const again = await setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false });
    expect(again?.paths).toEqual(paths);
    expect(findSession(loadHistory(), 'shop', 'feat/x')).toMatchObject({ paths, repos: ['api', 'web', 'docs'] });
  }, 60_000);

  it('teardown (no paths given, as the delete route calls it) removes all three worktrees', async () => {
    const [api, web, docs] = await sessionWithDocsOutsideItsGroup();
    expect(teardownWorktree('shop', true, 'feat/x', config, true)).toBe(true);
    for (const wt of [api, web, docs]) expect(fs.existsSync(wt)).toBe(false);
    expect(listed(config.repos.docs, docs)).toBe(false);
    expect(fs.existsSync(path.dirname(api))).toBe(false); // the empty group folder goes too
  }, 60_000);

  it('a row from before (no repos) is torn down over the group config, as before: docs stays', async () => {
    const [api, web, docs] = await sessionWithDocsOutsideItsGroup();
    saveHistory(loadHistory().map(({ repos: _repos, ...s }) => s));
    expect(teardownWorktree('shop', true, 'feat/x', config, true, [api, web, docs])).toBe(true);
    expect(fs.existsSync(api)).toBe(false);
    expect(fs.existsSync(web)).toBe(false);
    expect(fs.existsSync(docs)).toBe(true);
    expect(getCurrentBranch(docs)).toBe('feat/x');
  }, 60_000);

  it('re-entering a row from before follows the group config, as before, and stays a row from before', async () => {
    const [api, web] = await sessionWithDocsOutsideItsGroup();
    saveHistory(loadHistory().map(({ repos: _repos, ...s }) => s));
    const again = await setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false });
    expect(again?.paths).toEqual([api, web]);
    const row = findSession(loadHistory(), 'shop', 'feat/x');
    expect(row?.paths).toEqual([api, web]);
    expect(row).not.toHaveProperty('repos');
  }, 60_000);

  it('a row from before keeps following its group: a repo the group gets later is set up on the next re-entry', async () => {
    // Made with the group as api + web, its list not recorded (as before this change).
    config = { ...config, groups: { shop: ['api', 'web'] } };
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/y', config, undefined, undefined, { pull: false });
    saveHistory(loadHistory().map(({ repos: _repos, ...s }) => s));
    // The group gets docs; coming back sets docs up too, as it always did.
    config = { ...config, groups: { shop: ['api', 'web', 'docs'] } };
    saveConfig(config);
    const again = await setupWorktree('shop', 'feat/y', config, undefined, undefined, { pull: false });
    expect(again?.paths).toHaveLength(3);
    expect(again?.paths.slice(0, 2)).toEqual(made!.paths);
    expect(fs.existsSync(again!.paths[2])).toBe(true);
    expect(findSession(loadHistory(), 'shop', 'feat/y')).not.toHaveProperty('repos');
  }, 90_000);

  it('a recorded repo no longer in the config: not set up, said, kept on the session with its folder', async () => {
    const [api, web, docs] = await sessionWithDocsOutsideItsGroup();
    const { docs: _gone, ...repos } = config.repos;
    config = { ...config, repos };
    saveConfig(config);
    const reports = collectingReporter();
    const again = await withReporter(reports, () => setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false }));
    expect(again?.paths).toEqual([api, web]);
    expect(reports.entries.some((e) => e.level === 'warn' && /not in your config any more.*docs/.test(e.text))).toBe(true);
    // Not forgotten: docs stays listed, at its folder.
    expect(findSession(loadHistory(), 'shop', 'feat/x')).toMatchObject({ paths: [api, web, docs], repos: ['api', 'web', 'docs'] });
    // And teardown leaves it (git can't be asked), saying so, and not claiming all is gone.
    const down = collectingReporter();
    expect(withReporter(down, () => teardownWorktree('shop', true, 'feat/x', config, true))).toBe(false);
    expect(fs.existsSync(docs)).toBe(true);
    expect(down.entries.some((e) => e.level === 'warn' && /\[docs\] isn't in your config any more/.test(e.text))).toBe(true);
  }, 90_000);

  it("none of its repos in the config: refused, not opened as the group's config instead", async () => {
    await sessionWithDocsOutsideItsGroup();
    config = { ...config, repos: {}, groups: { shop: [] } };
    saveConfig(config);
    const reports = collectingReporter();
    expect(await withReporter(reports, () => setupWorktree('shop', 'feat/x', config, undefined, undefined, { pull: false }))).toBeNull();
    expect(reports.errors().join(' ')).toMatch(/none of this session's repos are in your config/);
  }, 60_000);

  it('a list that is there but damaged is matched by folder name, never read as the group config', async () => {
    const [api, web, docs] = await sessionWithDocsOutsideItsGroup();
    // Its list lost an entry: it no longer lines up with its paths.
    saveHistory(loadHistory().map((s) => ({ ...s, repos: ['api', 'docs'] })));
    expect(teardownWorktree('shop', true, 'feat/x', config, true)).toBe(true);
    // Read as the group's config, docs would have stayed; matched by folder name, it goes (web too: its group names it).
    for (const wt of [api, web, docs]) expect(fs.existsSync(wt)).toBe(false);
  }, 60_000);
});
