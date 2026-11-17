import { describe, expect, it, vi } from 'vitest';
import { localTreeRun, sessionTree, SEVERAL_REPOS_LINE, type LocalTreeDeps } from '../../../src/core/review/local-review-tree.js';
import { claudeReadDenyRules, internalClaudeReadOnlySpawn } from '../../../src/core/agents/claude/internal.js';
import { prepareLocalReview } from '../../../src/core/review/local-review.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** A session's own review read in the session's folder, read-only (reported: its notes asked what the repo answers). */
const FOLDER = '/wt/feat-x';
const paths = [`${FOLDER}/api`, `${FOLDER}/web`];

describe('sessionTree', () => {
  it('one repo: its own folder, paths as they are', () => {
    expect(sessionTree(paths, ['web'])).toMatchObject({ repos: [{ sub: null }] });
    expect(sessionTree(paths, ['web'])!.cwd.endsWith('/wt/feat-x/web')).toBe(true);
    expect(sessionTree(['/repos/api'], ['api'])!.cwd.endsWith('/repos/api')).toBe(true);
  });

  it('several: the folder that holds them, each under its name', () => {
    const t = sessionTree(paths, ['api', 'web'])!;
    expect(t.cwd.endsWith('/wt/feat-x')).toBe(true);
    expect(t.repos.map((r) => r.sub)).toEqual(['api', 'web']);
  });

  it('none when a name is no repo of it, two repos share a name, or they have no folder in common', () => {
    expect(sessionTree(paths, ['docs'])).toBeNull();
    expect(sessionTree(paths, [])).toBeNull();
    expect(sessionTree(['/a/api', '/b/api'], ['api'])).toBeNull();
    expect(sessionTree(['/a/api', '/b/web'], ['api', 'web'])).toBeNull();
  });
});

describe('localTreeRun', () => {
  const run = vi.fn(async (_prompt: string, _cwd: string, _deny: string[]): Promise<string | null> => 'answer');
  const deps = (over: Partial<LocalTreeDeps> = {}): LocalTreeDeps => ({
    readOnly: () => ({ localLines: ['You are in the folder.'], denyRules: () => ['Read(**/secret.json)'] }),
    run,
    exists: () => true,
    ...over,
  });

  it('runs in the folder that holds the repos, with their forbidden files, and says there are several', async () => {
    run.mockClear();
    const r = await localTreeRun(paths, ['api', 'web'], deps());
    if (!('ask' in r)) throw new Error(r.why);
    expect(r.lines).toEqual(['You are in the folder.', SEVERAL_REPOS_LINE]);
    expect(await r.ask('prompt')).toBe('answer');
    const [prompt, cwd, deny] = run.mock.calls[0];
    expect(prompt).toBe('prompt');
    expect(cwd.endsWith('/wt/feat-x')).toBe(true);
    expect(deny).toEqual(['Read(**/secret.json)']);
    // One repo: nothing said of several.
    const one = await localTreeRun(paths, ['web'], deps());
    expect('ask' in one && one.lines).toEqual(['You are in the folder.']);
  });

  it('says why it can’t: no read-only mode, repos not in one folder, a folder that is gone, a version it wasn’t measured on', async () => {
    run.mockClear();
    expect(await localTreeRun(paths, ['api'], deps({ readOnly: () => null }))).toEqual({ why: 'the agent has no read-only mode' });
    expect(await localTreeRun(paths, ['api'], deps({ readOnly: () => ({}) }))).toEqual({ why: 'the agent has no read-only mode' });
    expect(await localTreeRun(['/a/api', '/b/web'], ['api', 'web'], deps())).toEqual({ why: 'its repos are not in one folder' });
    expect(await localTreeRun(paths, ['api'], deps({ exists: () => false }))).toEqual({ why: 'its folder is not there' });
    const old = deps({ readOnly: () => ({ localLines: ['x'], available: async () => ({ ok: false, why: 'Claude Code is too old' }) }) });
    expect(await localTreeRun(paths, ['api'], old)).toEqual({ why: 'Claude Code is too old' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('the files a repo forbids reading hold for the run too', () => {
  const settings = (deny: unknown) => JSON.stringify({ permissions: { deny } });
  const files: Record<string, string> = {
    'api/.claude/settings.json': settings(['Read(**/appsettings.Production.json)', 'Read(./secrets/**)', 'Bash(rm:*)', 7, 'Read(a(b))']),
    'api/.claude/settings.local.json': settings(['Read(config/prod.env)', 'Read(~/.ssh/**)', 'Read(//etc/passwd)']),
    'web/.claude/settings.json': 'not json',
  };
  const read = (file: string) => files[file.replace(/\\/g, '/').replace(/^.*\/(api|web)\//, '$1/')] ?? null;

  it('only Read rules, each once; a rule relative to the repo is moved under its folder, one that means the same anywhere is not', () => {
    const rules = claudeReadDenyRules(
      [
        { dir: '/wt/feat-x/api', sub: 'api' },
        { dir: '/wt/feat-x/web', sub: 'web' },
      ],
      read,
    );
    expect(rules).toEqual([
      'Read(**/appsettings.Production.json)',
      'Read(api/secrets/**)',
      'Read(api/config/prod.env)',
      'Read(~/.ssh/**)',
      'Read(//etc/passwd)',
    ]);
  });

  it('a run in the repo’s own folder keeps the rules as written; no settings: none', () => {
    expect(claudeReadDenyRules([{ dir: '/wt/feat-x/api', sub: null }], read)).toContain('Read(./secrets/**)');
    expect(claudeReadDenyRules([{ dir: '/wt/feat-x/docs', sub: null }], read)).toEqual([]);
  });

  it('they go on the command line, after everything else; none: no flag', () => {
    const run = internalClaudeReadOnlySpawn({ cwd: '/wt/feat-x', deny: ['Read(**/a.json)', 'Read(api/b)'] });
    expect(run.args.slice(-3)).toEqual(['--disallowedTools', 'Read(**/a.json)', 'Read(api/b)']);
    expect(run.args).toContain('--restricted');
    expect(internalClaudeReadOnlySpawn({ cwd: '/wt/feat-x' }).args).not.toContain('--disallowedTools');
    expect(internalClaudeReadOnlySpawn({ cwd: '/wt/feat-x', deny: [] }).args).not.toContain('--disallowedTools');
  });
});

describe('prepareLocalReview read in the session’s folder', () => {
  const FILE = 'src/Shop.Core/Handlers/RefundHandler.cs';
  const files = parseGitDiff(
    [
      `diff --git a/${FILE} b/${FILE}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${FILE}`,
      '@@ -0,0 +1,2 @@',
      '+class A {',
      '+}',
      '',
    ].join('\n'),
  );
  const session = {
    target: 'api',
    branch: 'feat/x',
    isGroup: false,
    paths: ['/wt/x'],
    createdAt: 'x',
    lastAccessedAt: 'x',
  } as WorktreeSession;
  const diff = () => ({ repos: [{ name: 'x', files }], resolvedBase: 'origin/main' });
  const answer = JSON.stringify({
    stories: [{ title: 'A class.', why: 'W', risk: 'R', riskLevel: 3, flags: [], files: [FILE] }],
    notes: [],
  });

  it('asks there, with the folder’s lines in the prompt, and says so; the diff-only agent isn’t asked', async () => {
    const agent = vi.fn(async () => answer);
    const ask = vi.fn(async (_prompt: string) => answer);
    const inTree = vi.fn(async () => ({ lines: ['You are in the folder these changes are being made in.'], ask }));
    const p = await prepareLocalReview(session, undefined, { diff, agent, inTree });
    expect(inTree).toHaveBeenCalledWith(session, ['x']);
    expect(ask.mock.calls[0][0]).toContain('You are in the folder these changes are being made in.');
    expect(ask.mock.calls[0][0]).not.toContain('You have only this prompt');
    expect(agent).not.toHaveBeenCalled();
    expect(p.how).toBe('read in its folder');
    expect(p.review.aiStep).toBe('done');
  });

  it('no answer there: asked again on the diff alone, and said; it can’t run there: the diff alone, with why', async () => {
    const agent = vi.fn(async (_prompt: string) => answer);
    const silent = await prepareLocalReview(session, undefined, {
      diff,
      agent,
      inTree: async () => ({ lines: ['L'], ask: async () => null }),
    });
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0][0]).toContain('You have only this prompt');
    expect(silent.how).toBe('read from the diff alone (the run in its folder gave no answer)');
    const cant = await prepareLocalReview(session, undefined, {
      diff,
      agent,
      inTree: async () => ({ why: 'its repos are not in one folder' }),
    });
    expect(cant.how).toBe('read from the diff alone (its repos are not in one folder)');
    const threw = await prepareLocalReview(session, undefined, { diff, agent, inTree: async () => Promise.reject(new Error('boom')) });
    expect(threw.how).toBe('read from the diff alone (boom)');
    expect((await prepareLocalReview(session, undefined, { diff, agent })).how).toBe('read from the diff alone');
    expect((await prepareLocalReview(session, undefined, { diff })).how).toBeUndefined();
  });
});
