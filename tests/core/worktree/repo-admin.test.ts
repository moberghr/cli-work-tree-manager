import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfigDir, getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import {
  deleteGroup,
  enrollRepo,
  removeRepo,
  repoInventory,
  RepoAdminError,
  saveGroup,
  scanRootsOf,
  setRepoIgnored,
  setScanRoot,
} from '../../../src/core/worktree/repo-admin.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

let src: string; // like source\\repos
beforeAll(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-admin-'));
  for (const r of ['api', 'web', 'hangfire']) fs.mkdirSync(path.join(src, r, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'worktrees', 'api', 'feat', '.git'), { recursive: true });
});
afterAll(() => fs.rmSync(src, { recursive: true, force: true }));

/** config.json as a user has it, with a setting this code doesn't know. */
function seed(extra: Record<string, unknown> = {}) {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      worktreesRoot: path.join(src, 'worktrees'),
      repos: { api: path.join(src, 'api') },
      groups: {},
      copyFiles: [],
      someFutureSetting: { keep: true },
      ...extra,
    }),
  );
}
const raw = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;
const session = (target: string, branch: string, archived = false) =>
  ({
    target,
    branch,
    isGroup: false,
    paths: [],
    createdAt: '',
    lastAccessedAt: '',
    ...(archived ? { archivedAt: 'x' } : {}),
  }) as WorktreeSession;

beforeEach(() => seed());

describe('repoInventory: what the Repos page lists', () => {
  it('enrolled ones, the new ones found next to them (with an alias to take), not work’s own worktrees', () => {
    const inv = repoInventory(loadConfig()!, [session('api', 'feat/x'), session('api', 'old', true)]);
    expect(inv.roots).toEqual([src]);
    expect(inv.repos.map((r) => [r.folder, r.status, r.alias ?? r.suggestedAlias, r.sessions])).toEqual([
      ['api', 'enrolled', 'api', 1],
      ['hangfire', 'new', 'hangfire', 0],
      ['web', 'new', 'web', 0],
    ]);
  });

  it('flags two aliases on one folder, a folder that is gone, and a group short of repos', () => {
    seed({
      repos: { api: path.join(src, 'api'), 'api-old': path.join(src, 'api') + path.sep, gone: path.join(src, 'gone') },
      groups: { pair: ['api', 'ghost'] },
    });
    const inv = repoInventory(loadConfig()!, []);
    expect(inv.repos.find((r) => r.alias === 'api')?.sharedWith).toEqual(['api-old']);
    expect(inv.repos.find((r) => r.alias === 'gone')?.status).toBe('missing');
    expect(inv.groups[0]).toMatchObject({ name: 'pair', missing: ['ghost'], problem: 'not enrolled any more: ghost' });
  });
});

describe('changing repos (config.json under its lock, unknown settings kept)', () => {
  it('enrol: the alias and folder rules; it is then enrolled, no longer ignored', async () => {
    await setRepoIgnored(path.join(src, 'web'), true);
    expect(repoInventory(loadConfig()!, []).repos.find((r) => r.folder === 'web')?.status).toBe('ignored');
    await enrollRepo('web', path.join(src, 'web'));
    expect(loadConfig()!.repos.web).toBe(path.join(src, 'web'));
    expect(raw().ignoredRepos).toEqual([]);
    expect(raw().someFutureSetting).toEqual({ keep: true });
    await expect(enrollRepo('api', path.join(src, 'hangfire'))).rejects.toThrow(/already the alias/);
    await expect(enrollRepo('x', path.join(src, 'nope'))).rejects.toThrow(/not the top folder of a git repository/);
  });

  it('two writers at once lose nothing', async () => {
    await Promise.all([enrollRepo('web', path.join(src, 'web')), enrollRepo('hangfire', path.join(src, 'hangfire'))]);
    expect(Object.keys(loadConfig()!.repos).sort()).toEqual(['api', 'hangfire', 'web']);
  });

  it('remove: refused with live sessions (named) unless forced; it leaves its groups', async () => {
    await enrollRepo('web', path.join(src, 'web'));
    await saveGroup('shop', ['api', 'web'], { creating: true });
    const err = await removeRepo('web', [session('web', 'feat/y')]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoAdminError);
    expect((err as RepoAdminError).sessions).toEqual(['web · feat/y']);
    await removeRepo('web', [session('web', 'feat/y')], { force: true });
    expect(loadConfig()!.repos.web).toBeUndefined();
    expect(loadConfig()!.groups.shop).toEqual(['api']);
  });

  it('scanned folders: the first added replaces the default; a non-folder is refused', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-admin-root-'));
    try {
      await setScanRoot(other, true, loadConfig()!);
      expect(scanRootsOf(loadConfig()!)).toEqual([src, other]);
      await setScanRoot(src, false, loadConfig()!);
      expect(scanRootsOf(loadConfig()!)).toEqual([other]);
      await expect(setScanRoot(path.join(other, 'nope'), true, loadConfig()!)).rejects.toThrow(/not a folder/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('groups', () => {
  it('make one, change its repos, delete it (refused with live sessions unless forced; its instructions file goes)', async () => {
    await enrollRepo('web', path.join(src, 'web'));
    await saveGroup('shop', ['api', 'web'], { creating: true });
    await expect(saveGroup('shop', ['api', 'web'], { creating: true })).rejects.toThrow(/already exists/);
    await enrollRepo('hangfire', path.join(src, 'hangfire'));
    await saveGroup('shop', ['api', 'web', 'hangfire'], { creating: false });
    expect(loadConfig()!.groups.shop).toEqual(['api', 'web', 'hangfire']);
    fs.writeFileSync(path.join(getConfigDir(), 'shop.claude.md'), '# shop');
    await expect(deleteGroup('shop', [session('shop', 'feat/z')])).rejects.toThrow(/1 live session on shop/);
    await deleteGroup('shop', [session('shop', 'feat/z')], { force: true });
    expect(loadConfig()!.groups.shop).toBeUndefined();
    expect(fs.existsSync(path.join(getConfigDir(), 'shop.claude.md'))).toBe(false);
  });
});
