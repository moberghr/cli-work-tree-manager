import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, parseWorktreeList } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree, teardownWorktree } from '../../../src/core/worktree/worktree.js';
import { findSession, loadHistory, saveHistory } from '../../../src/core/sessions/history.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';
import { flatFolderName } from '../../../src/core/worktree/session-folder.js';
import { runInternal } from '../../../src/core/diff/checkpoint-summary.js';
import { generateGroupInstructions } from '../../../src/core/agents/group-instructions.js';

// Nothing may write a combined group file for a session folder: both ways to one are watched.
vi.mock('../../../src/core/diff/checkpoint-summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/diff/checkpoint-summary.js')>()),
  runInternal: vi.fn(async () => null),
}));
vi.mock('../../../src/core/agents/group-instructions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/agents/group-instructions.js')>()),
  generateGroupInstructions: vi.fn(),
}));

/**
 * Session folders (config `sessionFolders`, opt in): a new session is a folder
 * with one subfolder per repo, a single repo too, whose instructions file
 * imports each repo's own. Off, and for sessions that exist already, nothing changes.
 */

let fixture: string;
let tmp: string;
let config: WorkConfig;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-folders-fixture-'));
  for (const name of ['api', 'web']) {
    const dir = path.join(fixture, `${name}-repo`);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    // api has its own instructions; web has none.
    if (name === 'api') fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# api rules\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  }
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const configWith = (sessionFolders: boolean | undefined): WorkConfig => ({
  worktreesRoot: path.join(tmp, 'worktrees'),
  repos: { api: path.join(tmp, 'src', 'api-repo'), web: path.join(tmp, 'src', 'web-repo') },
  groups: { shop: ['api', 'web'] },
  copyFiles: [],
  ...(sessionFolders === undefined ? {} : { sessionFolders }),
});

beforeEach(() => {
  // Long-form (no 8.3 names): git prints worktree paths so.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-folders-')));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  fs.cpSync(fixture, path.join(tmp, 'src'), { recursive: true });
  config = configWith(true);
  saveConfig(config);
  // A group summary as `work config group add` would have written it: never copied into a session folder.
  fs.mkdirSync(path.join(tmp, '.work'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.work', 'shop.claude.md'), 'GROUP SUMMARY\n');
  vi.mocked(runInternal).mockClear();
  vi.mocked(generateGroupInstructions).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const norm = (p: string) => path.resolve(p).toLowerCase();
const listed = (repo: string, wt: string) => parseWorktreeList(repo).some((w) => norm(w.path) === norm(wt));
const noSummaryRun = () => {
  expect(runInternal).not.toHaveBeenCalled();
  expect(generateGroupInstructions).not.toHaveBeenCalled();
};

describe('sessionFolders on', () => {
  it('a single repo gets <root>/<branch-dir>-<id6>/<repo-folder>/, recorded as a folder session', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    // Named by its branch, the session's id telling it from another project's session of that branch name.
    const folder = path.join(config.worktreesRoot, flatFolderName('api', 'feat/x'));
    expect(path.basename(folder)).toMatch(/^feat-x-[0-9a-f]{6}$/);
    const wt = path.join(folder, 'api-repo');
    expect(made).toMatchObject({ launchDir: folder, paths: [wt], isGroup: true });
    expect(listed(config.repos.api, wt)).toBe(true);
    expect(findSession(loadHistory(), 'api', 'feat/x')).toMatchObject({ target: 'api', isGroup: true, paths: [wt], repos: ['api'] });
    // Its instructions file imports the repo's own.
    const text = fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('<!-- work:repos -->');
    expect(text).toContain('@api-repo/CLAUDE.md');
    noSummaryRun();
  }, 60_000);

  it('re-entering keeps the folder layout (and the instructions file)', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    const again = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    expect(again).toMatchObject({ launchDir: made!.launchDir, paths: made!.paths, isGroup: true });
    expect(findSession(loadHistory(), 'api', 'feat/x')).toMatchObject({ isGroup: true, paths: made!.paths, repos: ['api'] });
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toContain('@api-repo/CLAUDE.md');
  }, 60_000);

  it('re-entering with the switch turned off since keeps the folder layout', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    config = configWith(false);
    saveConfig(config);
    const again = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    expect(again).toMatchObject({ launchDir: made!.launchDir, paths: made!.paths, isGroup: true });
  }, 60_000);

  it('Restore after its folder was removed makes it again in the folder layout', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    expect(teardownWorktree('api', true, 'feat/x', config, true, made!.paths)).toBe(true);
    expect(fs.existsSync(made!.launchDir)).toBe(false);
    config = configWith(false);
    saveConfig(config);
    const back = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    expect(back).toMatchObject({ launchDir: made!.launchDir, paths: made!.paths, isGroup: true });
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toContain('@api-repo/CLAUDE.md');
  }, 60_000);

  it('teardown removes the worktree, the instructions file and the folder', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    const [wt] = made!.paths;
    // As the delete route calls it: the row's target and isGroup, no paths.
    expect(teardownWorktree('api', true, 'feat/x', config, true)).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(listed(config.repos.api, wt)).toBe(false);
    expect(fs.existsSync(path.join(made!.launchDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(made!.launchDir)).toBe(false);
  }, 60_000);

  it('teardown as `work remove <alias> <branch>` calls it (the target resolved as a repo: not a group) removes the folder too', async () => {
    const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
    expect(teardownWorktree('api', false, 'feat/x', config, true, made!.paths)).toBe(true);
    expect(fs.existsSync(made!.paths[0])).toBe(false);
    expect(fs.existsSync(made!.launchDir)).toBe(false);
  }, 60_000);

  it('a group session made so, restored after its folder was removed, gets the import file again', async () => {
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(teardownWorktree('shop', true, 'feat/g', config, true, made!.paths)).toBe(true);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    const text = fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('@api-repo/CLAUDE.md');
    expect(text).not.toContain('GROUP SUMMARY');
  }, 60_000);

  it('a group gets the import file, not the copied group summary, and no summary run', async () => {
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    const folder = path.join(config.worktreesRoot, flatFolderName('shop', 'feat/g'));
    expect(made).toMatchObject({ launchDir: folder, isGroup: true });
    const text = fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8');
    expect(text).not.toContain('GROUP SUMMARY');
    expect(text).toContain('@api-repo/CLAUDE.md');
    expect(text).not.toContain('@web-repo/'); // web has no CLAUDE.md
    // Re-entering keeps it an import file.
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8')).not.toContain('GROUP SUMMARY');
    noSummaryRun();
  }, 60_000);

  it('an existing single-repo session (made with the switch off) keeps its old layout', async () => {
    config = configWith(false);
    saveConfig(config);
    const old = await setupWorktree('api', 'feat/old', config, undefined, undefined, { pull: false });
    const oldPath = path.join(config.worktreesRoot, 'api-repo', 'feat-old');
    expect(old).toMatchObject({ launchDir: oldPath, isGroup: false });
    config = configWith(true);
    saveConfig(config);
    const again = await setupWorktree('api', 'feat/old', config, undefined, undefined, { pull: false });
    expect(again?.isGroup).toBe(false);
    expect([again!.launchDir, ...again!.paths].map(norm)).toEqual([norm(oldPath), norm(oldPath)]);
    const row = findSession(loadHistory(), 'api', 'feat/old');
    expect(row?.isGroup).toBe(false);
    expect(row?.paths.map(norm)).toEqual([norm(oldPath)]);
  }, 60_000);

  it('a worktree of the branch made outside a session is reused as it is, as today', async () => {
    const outside = path.join(tmp, 'elsewhere', 'feat-y');
    expect(git(['worktree', 'add', outside, '-b', 'feat/y'], config.repos.api).exitCode).toBe(0);
    const made = await setupWorktree('api', 'feat/y', config, undefined, undefined, { pull: false });
    expect(made?.isGroup).toBe(false);
    expect([made!.launchDir, ...made!.paths].map(norm)).toEqual([norm(outside), norm(outside)]);
    expect(fs.existsSync(path.join(config.worktreesRoot, 'api'))).toBe(false);
  }, 60_000);

  it('an existing group session made with the switch off keeps the copied summary', async () => {
    config = configWith(false);
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    config = configWith(true);
    saveConfig(config);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toBe('GROUP SUMMARY\n');
  }, 60_000);

  it('a group session made with the switch off, removed, then restored with it on: still the copied summary', async () => {
    config = configWith(false);
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(findSession(loadHistory(), 'shop', 'feat/g')).not.toHaveProperty('instructions');
    expect(teardownWorktree('shop', true, 'feat/g', config, true, made!.paths)).toBe(true);
    expect(fs.existsSync(path.join(made!.launchDir, 'CLAUDE.md'))).toBe(false);
    config = configWith(true);
    saveConfig(config);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toBe('GROUP SUMMARY\n');
  }, 60_000);

  it('a single-repo row from before (no repo list) re-entered with the switch on: the same row, still without a list', async () => {
    config = configWith(false);
    saveConfig(config);
    await setupWorktree('api', 'feat/old', config, undefined, undefined, { pull: false });
    saveHistory(loadHistory().map(({ repos: _repos, ...s }) => s));
    config = configWith(true);
    saveConfig(config);
    const again = await setupWorktree('api', 'feat/old', config, undefined, undefined, { pull: false });
    expect(again?.isGroup).toBe(false);
    const row = findSession(loadHistory(), 'api', 'feat/old');
    expect(row?.isGroup).toBe(false);
    expect(row).not.toHaveProperty('repos');
  }, 60_000);

  it('a group row from before, restored after its folder was removed (switch on): its summary, no list written', async () => {
    config = configWith(false);
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    saveHistory(loadHistory().map(({ repos: _repos, ...s }) => s));
    expect(teardownWorktree('shop', true, 'feat/g', config, true, made!.paths)).toBe(true);
    config = configWith(true);
    saveConfig(config);
    const again = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(again?.paths).toEqual(made!.paths);
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toBe('GROUP SUMMARY\n');
    const row = findSession(loadHistory(), 'shop', 'feat/g');
    expect(row).not.toHaveProperty('repos');
    expect(row).not.toHaveProperty('instructions');
  }, 90_000);

  it('a group worktree whose row was forgotten, with the switch on: torn down and re-entered where it is', async () => {
    config = configWith(false);
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    saveHistory([]); // "Delete … session only", or lost history: the worktrees stay, the row goes
    config = configWith(true);
    saveConfig(config);
    // Re-entry adopts the old folder (not a new flat one beside it, which git would refuse: already checked out).
    const again = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(again?.paths).toEqual(made!.paths);
    saveHistory([]);
    // And teardown removes it there, rather than reporting success over nothing.
    expect(teardownWorktree('shop', true, 'feat/g', config, true)).toBe(true);
    for (const p of made!.paths) expect(fs.existsSync(p)).toBe(false);
  }, 90_000);

  it('re-entering a group session warns about nothing routine (its worktrees being there is the point)', async () => {
    config = configWith(false);
    saveConfig(config);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    const reports = collectingReporter();
    await withReporter(reports, () => setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false }));
    expect(reports.entries.filter((e) => e.level === 'warn' && /already exists/.test(e.text))).toEqual([]);
    expect(reports.entries.some((e) => /already exists/.test(e.text))).toBe(true); // still said, as info
  }, 90_000);

  it('a session made with imports records it, so it gets them again whatever the switch says later', async () => {
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(findSession(loadHistory(), 'shop', 'feat/g')?.instructions).toBe('imports');
    expect(teardownWorktree('shop', true, 'feat/g', config, true, made!.paths)).toBe(true);
    config = configWith(false);
    saveConfig(config);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    const text = fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('@api-repo/CLAUDE.md');
    expect(text).not.toContain('GROUP SUMMARY');
  }, 60_000);
});

describe('sessionFolders off (the default)', () => {
  it.each([false, undefined])(
    'sessionFolders %s: a single repo is made exactly as today',
    async (flag) => {
      config = configWith(flag);
      saveConfig(config);
      const made = await setupWorktree('api', 'feat/x', config, undefined, undefined, { pull: false });
      const wt = path.join(config.worktreesRoot, 'api-repo', 'feat-x');
      expect(made).toEqual({ launchDir: wt, paths: [wt], isGroup: false, port: made!.port });
      expect(findSession(loadHistory(), 'api', 'feat/x')).toMatchObject({ target: 'api', isGroup: false, paths: [wt], repos: ['api'] });
      expect(fs.existsSync(path.join(config.worktreesRoot, 'api'))).toBe(false);
    },
    60_000,
  );

  it('a group copies the group summary as today', async () => {
    config = configWith(false);
    saveConfig(config);
    const made = await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    expect(fs.readFileSync(path.join(made!.launchDir, 'CLAUDE.md'), 'utf8')).toBe('GROUP SUMMARY\n');
  }, 60_000);
});
