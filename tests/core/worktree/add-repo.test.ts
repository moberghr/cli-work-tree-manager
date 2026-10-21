import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, parseWorktreeList } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { findSession, loadHistory, saveHistory, setSessionArchived } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { addedRepoNote, addRepoRefusal, addRepoToSession } from '../../../src/core/worktree/add-repo.js';
import { loadManifest, takeCheckpoint } from '../../../src/core/diff/checkpoint.js';
import { scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';

vi.mock('../../../src/core/diff/checkpoint-summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/diff/checkpoint-summary.js')>()),
  runInternal: vi.fn(async () => null),
}));

/**
 * Add a repo to a session folder: checked out into the folder on the
 * session's branch, recorded on the session, the folder's instructions
 * import it, the turn history carried over. Every refusal changes nothing.
 */

let fixture: string;
let tmp: string;
let config: WorkConfig;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'add-repo-fixture-'));
  for (const name of ['api', 'web', 'docs']) {
    const dir = path.join(fixture, `${name}-repo`);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${name} rules\n`);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  }
  // web has a `dev` branch ahead of main, and its own feat/existing.
  const web = path.join(fixture, 'web-repo');
  git(['branch', 'dev'], web);
  git(['checkout', '-q', 'dev'], web);
  fs.writeFileSync(path.join(web, 'dev.txt'), 'dev\n');
  git(['add', '.'], web);
  git(['commit', '-m', 'dev work', '--no-gpg-sign'], web);
  git(['checkout', '-q', '-b', 'feat/existing', 'main'], web);
  fs.writeFileSync(path.join(web, 'existing.txt'), 'existing\n');
  git(['add', '.'], web);
  git(['commit', '-m', 'existing work', '--no-gpg-sign'], web);
  git(['checkout', '-q', 'main'], web);
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const configWith = (sessionFolders: boolean): WorkConfig => ({
  worktreesRoot: path.join(tmp, 'worktrees'),
  repos: {
    api: path.join(tmp, 'src', 'api-repo'),
    web: path.join(tmp, 'src', 'web-repo'),
    docs: path.join(tmp, 'src', 'docs-repo'),
    // Another repo whose folder has api's name.
    apicopy: path.join(tmp, 'other', 'api-repo'),
  },
  groups: { shop: ['api', 'web'] },
  copyFiles: [],
  sessionFolders,
});

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'add-repo-')));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  fs.cpSync(fixture, path.join(tmp, 'src'), { recursive: true });
  config = configWith(true);
  saveConfig(config);
  fs.mkdirSync(path.join(tmp, '.work'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.work', 'shop.claude.md'), 'GROUP SUMMARY\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const norm = (p: string) => path.resolve(p).toLowerCase();
const row = (target: string, branch: string) => findSession(loadHistory(), target, branch);
const head = (dir: string, rev = 'HEAD') => git(['rev-parse', rev], dir).stdout;

async function folderSession(target = 'api', branch = 'feat/x') {
  const made = await setupWorktree(target, branch, config, undefined, undefined, { pull: false });
  expect(made?.isGroup).toBe(true);
  const s = row(target, branch)!;
  return { s, id: sessionIdFor(s), folder: path.dirname(s.paths[0]) };
}

describe('addRepoToSession', () => {
  it('a repo without the branch: a new one from its checkout, recorded, imported', async () => {
    const { s, id, folder } = await folderSession();
    const r = await addRepoToSession(id, 'web');
    const wt = path.join(folder, 'web-repo');
    expect(r).toEqual({ alias: 'web', path: wt, branch: 'feat/x', created: true, from: 'main' });
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt).stdout).toBe('feat/x');
    expect(head(wt)).toBe(head(config.repos.web, 'main'));
    expect(parseWorktreeList(config.repos.web).some((w) => norm(w.path) === norm(wt))).toBe(true);
    const after = row('api', 'feat/x')!;
    expect(after.paths).toEqual([...s.paths, wt]);
    expect(after.repos).toEqual(['api', 'web']);
    expect(after.baseBranches?.[wt]).toBe('main');
    expect({ ...after, paths: s.paths, repos: s.repos, baseBranches: s.baseBranches }).toEqual(s); // nothing else changed
    const text = fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('@api-repo/CLAUDE.md');
    expect(text).toContain('@web-repo/CLAUDE.md');
  }, 90_000);

  it("the session's branch existing in the repo: checked out as it is", async () => {
    const { id, folder } = await folderSession('api', 'feat/existing');
    const r = await addRepoToSession(id, 'web', { base: 'dev' });
    expect(r).toEqual({ alias: 'web', path: path.join(folder, 'web-repo'), branch: 'feat/existing', created: false });
    expect(head(r.path)).toBe(head(config.repos.web, 'feat/existing'));
    expect(row('api', 'feat/existing')!.baseBranches?.[r.path]).toBeUndefined();
  }, 90_000);

  it('a new branch from the base given', async () => {
    const { id } = await folderSession();
    const r = await addRepoToSession(id, 'web', { base: 'dev' });
    expect(r).toMatchObject({ created: true, from: 'dev' });
    expect(head(r.path)).toBe(head(config.repos.web, 'dev'));
    expect(row('api', 'feat/x')!.baseBranches?.[r.path]).toBe('dev');
  }, 90_000);

  it("carries the Diff tab's turns over to the session's new scope", async () => {
    const { s, id } = await folderSession();
    const oldHash = scopeHashForPaths(s.paths);
    const scopeRepos = s.paths.map((root) => ({ name: path.basename(root), root }));
    await takeCheckpoint(oldHash, scopeRepos);
    fs.writeFileSync(path.join(s.paths[0], 'x.txt'), 'turn\n');
    await takeCheckpoint(oldHash, scopeRepos);
    await addRepoToSession(id, 'web');
    const now = row('api', 'feat/x')!;
    expect(loadManifest(scopeHashForPaths(now.paths)).entries.map((e) => e.id)).toEqual([0, 1]);
    expect(loadManifest(oldHash).entries).toEqual([]);
  }, 90_000);

  it('a group session with a copied summary keeps it, the imports after it', async () => {
    config = configWith(false);
    saveConfig(config);
    const { id, folder } = await folderSession('shop', 'feat/g');
    expect(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8')).toBe('GROUP SUMMARY\n');
    await addRepoToSession(id, 'docs');
    const text = fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8');
    expect(text.startsWith('GROUP SUMMARY\n')).toBe(true);
    expect(text).toContain('<!-- work:repos -->');
    expect(text).toContain('@docs-repo/CLAUDE.md');
    expect(row('shop', 'feat/g')!.repos).toEqual(['api', 'web', 'docs']);
  }, 90_000);

  it('a group row from before repos were recorded gets its list recorded with the new one', async () => {
    const { id } = await folderSession('shop', 'feat/g');
    saveHistory(loadHistory().map((x) => (sessionIdFor(x) === id ? { ...x, repos: undefined } : x)));
    await addRepoToSession(id, 'docs');
    expect(row('shop', 'feat/g')!.repos).toEqual(['api', 'web', 'docs']);
  }, 90_000);
});

describe('refusals change nothing', () => {
  const refused = async (id: string, alias: string, message: RegExp, opts: { base?: string } = {}) => {
    const before = loadHistory();
    const dirs = fs.existsSync(config.worktreesRoot) ? fs.readdirSync(config.worktreesRoot, { recursive: true }).sort() : [];
    await expect(addRepoToSession(id, alias, opts)).rejects.toThrow(message);
    expect(loadHistory()).toEqual(before);
    expect(fs.existsSync(config.worktreesRoot) ? fs.readdirSync(config.worktreesRoot, { recursive: true }).sort() : []).toEqual(dirs);
  };

  it('an unknown session', async () => {
    await refused('nope', 'web', /unknown session/);
  });

  it('an archived session', async () => {
    const { id } = await folderSession();
    await setSessionArchived('api', 'feat/x', true);
    await refused(id, 'web', /archived/);
  }, 90_000);

  it('a single repo in the old layout, saying it needs a session folder', async () => {
    config = configWith(false);
    saveConfig(config);
    await setupWorktree('api', 'feat/old', config, undefined, undefined, { pull: false });
    const id = sessionIdFor(row('api', 'feat/old')!);
    await refused(id, 'web', /not a session folder.*sessionFolders: true/);
  }, 90_000);

  it('an unknown alias', async () => {
    const { id } = await folderSession();
    await refused(id, 'nope', /no repo called nope/);
  }, 90_000);

  it('a repo already in the session', async () => {
    const { id } = await folderSession();
    await refused(id, 'api', /in this session already/);
  }, 90_000);

  it('a folder name the session already has', async () => {
    const { id } = await folderSession();
    await refused(id, 'apicopy', /already has a folder called api-repo/);
  }, 90_000);

  it('a folder of that name already in the session folder', async () => {
    const { id, folder } = await folderSession();
    fs.mkdirSync(path.join(folder, 'web-repo'));
    await refused(id, 'web', /already exists in the session folder/);
  }, 90_000);

  it('a base starting with "-"', async () => {
    const { id } = await folderSession();
    await refused(id, 'web', /not a valid/, { base: '--upload-pack=x' });
  }, 90_000);

  it('a checkout git refuses (a base that does not exist) records nothing', async () => {
    const { id } = await folderSession();
    await refused(id, 'web', /Base branch 'nope' does not exist/, { base: 'nope' });
  }, 90_000);
});

describe('addRepoRefusal', () => {
  const s = {
    target: 'shop',
    isGroup: true,
    branch: 'b',
    paths: ['/w/shop/b/api-repo'],
    repos: ['api'],
    createdAt: '',
    lastAccessedAt: '',
  };
  const cfg = { repos: { api: '/r/api-repo', web: '/r/web-repo' }, groups: {} };
  it('answers with a status', () => {
    expect(addRepoRefusal(null, 'web', cfg, () => false)?.status).toBe(404);
    expect(addRepoRefusal(s, 'nope', cfg, () => false)?.status).toBe(400);
    expect(addRepoRefusal(s, 'api', cfg, () => false)?.status).toBe(409);
    expect(addRepoRefusal({ ...s, archivedAt: 'x' }, 'web', cfg, () => false)?.status).toBe(409);
    expect(addRepoRefusal(s, 'web', cfg, () => false)).toBeNull();
  });
});

describe('addedRepoNote', () => {
  it('says where, on which branch, and from what', () => {
    expect(addedRepoNote({ alias: 'web', path: '/w/x/web-repo', branch: 'feat/x', from: 'main' })).toBe(
      "Added repo web to this session: ./web-repo on branch feat/x, made from main. Its CLAUDE.md is imported by the session's instructions file.",
    );
    expect(addedRepoNote({ alias: 'web', path: '/w/x/web-repo', branch: 'feat/x' })).not.toContain('made from');
  });
});
