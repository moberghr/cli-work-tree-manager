import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, parseWorktreeList } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree, teardownWorktree } from '../../../src/core/worktree/worktree.js';
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
  // Each with an origin, as a real repo has (its own checkout's pull has an upstream to pull from).
  for (const name of ['api', 'web', 'docs']) {
    const dir = path.join(fixture, `${name}-repo`);
    const origin = path.join(fixture, `${name}.git`);
    git(['init', '-q', '--bare', '-b', 'main', origin], fixture);
    git(['remote', 'add', 'origin', origin], dir);
    git(['push', '-q', '--all', 'origin'], dir);
    git(['branch', '-q', '--set-upstream-to=origin/main', 'main'], dir);
  }
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
    expect(r).toEqual({ alias: 'web', path: wt, branch: 'feat/x', created: true, from: 'main', imported: true, warnings: [] });
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
    expect(r).toEqual({
      alias: 'web',
      path: path.join(folder, 'web-repo'),
      branch: 'feat/existing',
      created: false,
      imported: true,
      // A base is for a new branch only: said.
      warnings: ['feat/existing exists already in this repo: checked out as it is (not from dev)'],
    });
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
    const r = await addRepoToSession(id, 'web');
    expect(r.warnings).toEqual([]);
    const now = row('api', 'feat/x')!;
    const newHash = scopeHashForPaths(now.paths);
    expect(loadManifest(newHash).entries.map((e) => e.id)).toEqual([0, 1]);
    expect(loadManifest(oldHash).entries).toEqual([]);
    const refsIn = (repo: string, hash: string) =>
      git(['for-each-ref', '--format=%(refname)', `refs/wd/${hash}/`], repo)
        .stdout.split('\n')
        .filter(Boolean);
    expect(refsIn(s.paths[0], newHash)).toHaveLength(2);
    expect(refsIn(s.paths[0], oldHash)).toEqual([]);
    // The next turn: over both repos, numbered on from the old ones.
    const next = await takeCheckpoint(
      newHash,
      now.paths.map((root) => ({ name: path.basename(root), root })),
    );
    expect(next?.id).toBe(2);
    expect(Object.keys(next?.repos ?? {}).sort()).toEqual(['api-repo', 'web-repo']);
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
    // How its file is made is recorded, so a Restore makes it the same way.
    expect(row('shop', 'feat/g')!.instructions).toBe('summary+imports');
  }, 90_000);

  it("Restore after its worktree was removed: the group's summary and the added repo's import, as before", async () => {
    config = configWith(false);
    saveConfig(config);
    const { id, folder } = await folderSession('shop', 'feat/g');
    await addRepoToSession(id, 'docs');
    const s = row('shop', 'feat/g')!;
    // Archive removes the worktrees, the folder's file with them.
    expect(teardownWorktree('shop', true, 'feat/g', config, true, s.paths)).toBe(true);
    expect(fs.existsSync(path.join(folder, 'CLAUDE.md'))).toBe(false);
    await setupWorktree('shop', 'feat/g', config, undefined, undefined, { pull: false });
    const text = fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8');
    expect(text.startsWith('GROUP SUMMARY\n')).toBe(true);
    expect(text).toContain('@docs-repo/CLAUDE.md');
    expect(row('shop', 'feat/g')!.repos).toEqual(['api', 'web', 'docs']);
  }, 120_000);

  it('a repo session folder records plain imports', async () => {
    const { id } = await folderSession();
    await addRepoToSession(id, 'web');
    expect(row('api', 'feat/x')!.instructions).toBe('imports');
  }, 90_000);

  it("what the checkout warned about is in the result (work web's child answers with it alone)", async () => {
    // The repo's own checkout isn't on main/master/dev: the new branch comes from it, and that's said.
    git(['checkout', '-q', '-b', 'side'], config.repos.web);
    const { id } = await folderSession();
    const r = await addRepoToSession(id, 'web');
    expect(r.warnings.join(' ')).toMatch(/base repo is on 'side'/);
  }, 90_000);

  it('a group row from before repos were recorded gets its list recorded with the new one', async () => {
    const { id } = await folderSession('shop', 'feat/g');
    saveHistory(loadHistory().map((x) => (sessionIdFor(x) === id ? { ...x, repos: undefined } : x)));
    await addRepoToSession(id, 'docs');
    expect(row('shop', 'feat/g')!.repos).toEqual(['api', 'web', 'docs']);
  }, 90_000);
});

describe('after the checkout', () => {
  it("a checkout that can't be recorded is removed again, branch and all, and says so", async () => {
    const { s, id, folder } = await folderSession();
    const wt = path.join(folder, 'web-repo');
    await expect(
      addRepoToSession(
        id,
        'web',
        {},
        {
          record: () => {
            throw new Error('database is locked');
          },
        },
      ),
    ).rejects.toThrow(/couldn't record web on the session \(database is locked\); its checkout was removed again/);
    expect(fs.existsSync(wt)).toBe(false);
    expect(parseWorktreeList(config.repos.web).some((w) => norm(w.path) === norm(wt))).toBe(false);
    expect(git(['branch', '--list', 'feat/x'], config.repos.web).stdout).toBe('');
    expect(row('api', 'feat/x')).toEqual(s);
    // And a retry works: nothing is left in its way.
    expect((await addRepoToSession(id, 'web')).path).toBe(wt);
  }, 120_000);

  it('a branch the repo had already is kept when the checkout is undone (only its worktree goes)', async () => {
    const { id, folder } = await folderSession('api', 'feat/existing');
    const tip = head(config.repos.web, 'feat/existing');
    await expect(addRepoToSession(id, 'web', {}, { record: () => null })).rejects.toThrow(/removed again/);
    expect(fs.existsSync(path.join(folder, 'web-repo'))).toBe(false);
    expect(head(config.repos.web, 'feat/existing')).toBe(tip);
  }, 90_000);

  it('a session gone by the time it is recorded: the same', async () => {
    const { id, folder } = await folderSession();
    await expect(addRepoToSession(id, 'web', {}, { record: () => null })).rejects.toThrow(/the session is gone/);
    expect(fs.existsSync(path.join(folder, 'web-repo'))).toBe(false);
  }, 90_000);

  it("one that can't be removed either names its folder", async () => {
    const { id, folder } = await folderSession();
    await expect(addRepoToSession(id, 'web', {}, { record: () => null, undoCheckout: () => false })).rejects.toThrow(
      new RegExp(`still at .*web-repo: remove it by hand`),
    );
    expect(fs.existsSync(path.join(folder, 'web-repo'))).toBe(true);
  }, 90_000);

  it("the turns that can't be carried over: the repo stays added, and the result says why", async () => {
    const { id } = await folderSession();
    const r = await addRepoToSession(
      id,
      'web',
      {},
      {
        migrate: async () => {
          throw new Error('disk full');
        },
      },
    );
    expect(r.warnings).toEqual(["couldn't carry the Diff tab's turns over: disk full"]);
    expect(row('api', 'feat/x')!.repos).toEqual(['api', 'web']);
  }, 90_000);

  it("the move's own problems are passed on", async () => {
    const { id } = await folderSession();
    const r = await addRepoToSession(
      id,
      'web',
      {},
      {
        migrate: async (a, b) => ({ from: a.join(), to: b.join(), manifest: false, refs: 0, comments: 0, problems: ['x'] }),
      },
    );
    expect(r.warnings).toEqual(["the Diff tab's turns: x"]);
  }, 90_000);

  it("an instructions file that can't be written: the repo stays added, not imported, said", async () => {
    const { id } = await folderSession();
    const r = await addRepoToSession(
      id,
      'web',
      {},
      {
        instructions: () => {
          throw new Error('EBUSY');
        },
      },
    );
    expect(r).toMatchObject({ imported: false, warnings: ["couldn't update the session folder's instructions file: EBUSY"] });
    expect(row('api', 'feat/x')!.repos).toEqual(['api', 'web']);
  }, 90_000);

  it("an agent that can't import: the file left as it is, the repo not imported, said", async () => {
    const { id } = await folderSession();
    const r = await addRepoToSession(id, 'web', {}, { instructions: () => ({ file: 'AGENTS.md', imported: null }) });
    expect(r).toMatchObject({ imported: false });
    expect(r.warnings).toEqual(["its agent can't import files into AGENTS.md: the session folder's file is left as it is"]);
  }, 90_000);

  it('a checkout that failed (as the deps say) records nothing and moves nothing', async () => {
    const { s, id } = await folderSession();
    let moved = false;
    await expect(
      addRepoToSession(
        id,
        'web',
        {},
        {
          checkout: () => ({ ok: false, error: 'git said no' }),
          migrate: async () => {
            moved = true;
            throw new Error('never');
          },
        },
      ),
    ).rejects.toThrow('git said no');
    expect(moved).toBe(false);
    expect(row('api', 'feat/x')).toEqual(s);
  }, 90_000);
});

describe('refusals change nothing', () => {
  /** Everything an add could touch: the history, the folders, the instructions files, the repos' worktrees and branches, the turn lists. */
  const snapshot = () => {
    const files = fs.existsSync(config.worktreesRoot) ? (fs.readdirSync(config.worktreesRoot, { recursive: true }) as string[]).sort() : [];
    const texts = files
      .filter((f) => /(CLAUDE|AGENTS)\.md$/.test(f))
      .map((f) => fs.readFileSync(path.join(config.worktreesRoot, f), 'utf8'));
    const repos = Object.values(config.repos)
      .filter((r) => fs.existsSync(r))
      .map((r) => [git(['worktree', 'list', '--porcelain'], r).stdout, git(['branch', '--list'], r).stdout]);
    const diffs = path.join(tmp, '.work', 'diffs');
    const manifests = fs.existsSync(diffs) ? fs.readdirSync(diffs).sort() : [];
    return { history: loadHistory(), files, texts, repos, manifests };
  };
  const refused = async (id: string, alias: string, message: RegExp, opts: { base?: string } = {}) => {
    const before = snapshot();
    // Refused before git is asked anything (but the checkout git itself refuses, which uses the real one).
    await expect(addRepoToSession(id, alias, opts)).rejects.toThrow(message);
    expect(snapshot()).toEqual(before);
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

  it('refuses a row from before with a folder no repo of its group has (it would record a made-up alias)', () => {
    const legacy = { ...s, repos: undefined, paths: ['/w/shop/b/api-repo', '/w/shop/b/mystery'] };
    const r = addRepoRefusal(legacy, 'web', { ...cfg, groups: { shop: ['api'] } }, () => false);
    expect(r).toEqual({ status: 409, error: 'no repo of shop is in its folder mystery: add that repo back to the group first' });
  });

  it('a row from before whose folders all match: allowed', () => {
    const legacy = { ...s, repos: undefined };
    expect(addRepoRefusal(legacy, 'web', { ...cfg, groups: { shop: ['api'] } }, () => false)).toBeNull();
  });
});

describe('addedRepoNote', () => {
  it('says where, on which branch, and from what', () => {
    expect(addedRepoNote({ alias: 'web', path: '/w/x/web-repo', branch: 'feat/x', from: 'main', imported: true })).toBe(
      "Added repo web to this session: ./web-repo on branch feat/x, made from main. Its CLAUDE.md is imported by the session's instructions file.",
    );
    expect(addedRepoNote({ alias: 'web', path: '/w/x/web-repo', branch: 'feat/x' })).not.toContain('made from');
  });

  it("doesn't claim an import that isn't there (no file, or an agent that can't import)", () => {
    const note = addedRepoNote({ alias: 'web', path: '/w/x/web-repo', branch: 'feat/x', imported: false }, 'AGENTS.md');
    expect(note).not.toContain('is imported');
    expect(note).toContain('./web-repo/AGENTS.md');
  });
});
