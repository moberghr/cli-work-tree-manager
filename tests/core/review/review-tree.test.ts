import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../../src/core/platform/command-runner.js';
import { reviewRef } from '../../../src/core/review/review-source.js';
import {
  createReviewTree,
  NO_LFS,
  NO_LFS_ENV,
  reviewTreeName,
  sweepReviewTrees,
  withReviewTree,
  type ReviewTreeAt,
} from '../../../src/core/review/review-tree.js';
import { claudeSettingsFile as isSettingsFile } from '../../../src/core/agents/claude/internal.js';
import type { CommandRunner } from '../../../src/core/platform/command-runner.js';
import { killTree } from '../../functional/fixtures/processes.js';
import { agentInCheckout, CHECKOUT_AGENT_TIMEOUT_MS } from '../../../src/core/review/review-deps.js';
import { registerAgent } from '../../../src/core/agents/index.js';
import { internalCanRead, internalReadOnly, runInternalReadOnly } from '../../../src/core/diff/checkpoint-summary.js';
import type { AgentAdapter } from '../../../src/core/agents/types.js';

/**
 * A PR's temporary checkout for the Reviews AI step, against a real repo: the PR's commit (at its review ref) carries
 * Claude Code settings files (root and nested), an MCP config, a husky-style hooks folder with a post-checkout hook,
 * and a symlink — the checkout is at that commit, the settings gone, CLAUDE.md and .claude/rules kept, no hook run,
 * no link; and it is removed after a success, a failure and a timeout, and swept when a stopped run left one.
 */

let base: string;
let repoTemplate: string;
let prSha: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-tree-')));
  repoTemplate = path.join(base, 'template');
  git(base, 'init', '-q', '-b', 'main', repoTemplate);
  for (const [k, v] of [
    ['user.email', 'a@example.com'],
    ['user.name', 'A'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ])
    git(repoTemplate, 'config', k, v);
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repoTemplate, rel)), { recursive: true });
    fs.writeFileSync(path.join(repoTemplate, rel), text);
  };
  w('README.md', 'base\n');
  // A husky-style hooks folder in the repo (`core.hooksPath=.husky`): a plain checkout runs its post-checkout.
  w('.husky/post-checkout', `#!/bin/sh\necho ran > "${path.join(base, 'hook-ran').replace(/\\/g, '/')}"\n`);
  git(repoTemplate, 'add', '.');
  git(repoTemplate, 'update-index', '--chmod=+x', '.husky/post-checkout');
  git(repoTemplate, 'commit', '-q', '-m', 'base');
  git(repoTemplate, 'checkout', '-q', '-b', 'pr');
  w('CLAUDE.md', 'Use tabs.\n');
  w('.claude/rules/style.md', 'No classes.\n');
  w('.claude/settings.json', '{"hooks":{"SessionStart":[]}}\n');
  w('.claude/settings.local.json', '{}\n');
  w('.mcp.json', '{"mcpServers":{}}\n');
  w('pkg/.claude/settings.json', '{}\n');
  w('pkg/CLAUDE.md', 'Nested.\n');
  w('src/Logic.cs', 'class Logic {}\n');
  git(repoTemplate, 'add', '.');
  // A symlink pointing out of the tree (as a git object: no symlink privilege needed on Windows).
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repoTemplate, input: '../../secret', encoding: 'utf8' }).trim();
  git(repoTemplate, 'update-index', '--add', '--cacheinfo', `120000,${blob},src/link`);
  git(repoTemplate, 'commit', '-q', '-m', 'the PR');
  prSha = git(repoTemplate, 'rev-parse', 'HEAD');
  git(repoTemplate, 'checkout', '-q', 'main');
  git(repoTemplate, 'update-ref', reviewRef(5), prSha);
  git(repoTemplate, 'config', 'core.hooksPath', '.husky');
}, 60_000);

afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

let repo: string;
let root: string;
let at: ReviewTreeAt;
let n = 0;
beforeEach(() => {
  n += 1;
  repo = path.join(base, `repo-${n}`);
  fs.cpSync(repoTemplate, repo, { recursive: true });
  root = path.join(base, `trees-${n}`);
  at = { repoPath: repo, alias: 'api', number: 5, headSha: prSha };
});

const worktrees = () => git(repo, 'worktree', 'list', '--porcelain');

describe("the settings files Claude Code reads (its adapter's rule), and the folder name", () => {
  it('in any case: a case-blind file system opens .Claude/settings.json and .MCP.json as the settings files (#64 F004)', () => {
    expect(['.Claude/settings.json', '.MCP.json', 'a/.CLAUDE/Settings.Local.JSON', 'B\\.Claude\\SETTINGS.json'].every(isSettingsFile)).toBe(
      true,
    );
    expect(['Claude.md', '.Claude/Rules/x.md', 'x/.claude/settings.JSONC'].some(isSettingsFile)).toBe(false);
  });

  it('settings.json / settings.local.json under any .claude, and .mcp.json; never CLAUDE.md or rules', () => {
    expect(
      ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'a/b/.claude/settings.json', 'a\\.mcp.json'].every(
        isSettingsFile,
      ),
    ).toBe(true);
    expect(
      ['CLAUDE.md', '.claude/rules/x.md', '.claude/commands/c.md', 'settings.json', 'x/.claude/settings.jsonc'].some(isSettingsFile),
    ).toBe(false);
    expect(reviewTreeName('api', 5, 'abcdef1234567')).toBe('api-5-abcdef12');
    expect(reviewTreeName('../evil name', 5, 'abc')).toBe('__evil_name-5-abc');
  });
});

describe('a temporary checkout of the PR', () => {
  it('is a detached worktree at the reviewed commit, its settings files gone, its CLAUDE.md and rules kept, no hook run, no symlink', async () => {
    const t = await createReviewTree(defaultRunner, at, { root, strip: isSettingsFile });
    if (!t.ok) throw new Error(t.error);
    expect(path.basename(t.dir)).toBe(reviewTreeName('api', 5, prSha));
    expect(git(t.dir, 'rev-parse', 'HEAD')).toBe(prSha);
    expect(git(t.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached
    expect(t.removed.sort()).toEqual(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'pkg/.claude/settings.json']);
    for (const rel of t.removed) expect(fs.existsSync(path.join(t.dir, rel))).toBe(false);
    expect(fs.readFileSync(path.join(t.dir, 'CLAUDE.md'), 'utf8')).toBe('Use tabs.\n');
    expect(fs.existsSync(path.join(t.dir, '.claude', 'rules', 'style.md'))).toBe(true);
    expect(fs.existsSync(path.join(t.dir, 'pkg', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'hook-ran'))).toBe(false); // the PR's post-checkout never ran
    expect(fs.lstatSync(path.join(t.dir, 'src', 'link')).isSymbolicLink()).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // the user's checkout untouched
    // The control: a plain `git worktree add` of the same commit does run the PR's hook.
    git(repo, 'worktree', 'add', '--detach', '--quiet', path.join(base, `control-${n}`), prSha);
    expect(fs.existsSync(path.join(base, 'hook-ran'))).toBe(true);
    fs.rmSync(path.join(base, 'hook-ran'));
  });

  it('is removed after the agent read it, and git forgets it', async () => {
    let seen = '';
    const r = await withReviewTree(
      defaultRunner,
      at,
      async (dir) => {
        seen = dir;
        expect(fs.existsSync(path.join(dir, 'src', 'Logic.cs'))).toBe(true);
        return 'answer';
      },
      { root, strip: isSettingsFile },
    );
    expect(r).toEqual({ ok: true, value: 'answer' });
    expect(fs.existsSync(seen)).toBe(false);
    expect(worktrees()).not.toContain(path.basename(seen));
  });

  it('is removed when the run throws, and the error goes on', async () => {
    let seen = '';
    await expect(
      withReviewTree(
        defaultRunner,
        at,
        async (dir) => {
          seen = dir;
          fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked'); // --force: removed even with changes
          throw new Error('agent crashed');
        },
        { root, strip: isSettingsFile },
      ),
    ).rejects.toThrow('agent crashed');
    expect(fs.existsSync(seen)).toBe(false);
    expect(worktrees()).not.toContain(path.basename(seen));
  });

  it('a commit that is not the review ref’s (the PR moved): refused, and nothing is left', async () => {
    const r = await createReviewTree(defaultRunner, { ...at, headSha: '0'.repeat(40) }, { root, strip: isSettingsFile });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('reviewed commit') });
    expect(fs.readdirSync(root).filter((d) => !d.startsWith('.'))).toEqual([]);
    expect(worktrees().split('worktree ').length).toBe(2); // the repo alone
  });

  it('a review ref that is not there: refused with git’s reason, nothing left', async () => {
    const r = await createReviewTree(defaultRunner, { ...at, number: 99 }, { root, strip: isSettingsFile });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("couldn't check the PR out") });
    expect(fs.readdirSync(root).filter((d) => !d.startsWith('.'))).toEqual([]);
  });
});

describe('sweeping what a stopped run left', () => {
  it('removes a leftover checkout through its repo (git forgets it) and a stray folder; leaves a young one', async () => {
    const t = await createReviewTree(defaultRunner, at, { root, strip: isSettingsFile });
    if (!t.ok) throw new Error(t.error);
    fs.mkdirSync(path.join(root, 'stray-1-abc'));
    const young = await sweepReviewTrees(defaultRunner, { root, olderThanMs: 60_000 });
    expect(young).toEqual({ swept: [], failed: [] });
    const r = await sweepReviewTrees(defaultRunner, { root, olderThanMs: 60_000, now: () => Date.now() + 120_000 });
    expect(r.swept.sort()).toEqual([path.basename(t.dir), 'stray-1-abc'].sort());
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(t.dir)).toBe(false);
    expect(worktrees()).not.toContain(path.basename(t.dir));
    expect(await sweepReviewTrees(defaultRunner, { root: path.join(base, 'none') })).toEqual({ swept: [], failed: [] });
  });
});

describe('the AI step in a checkout (review-deps `agentInCheckout`)', () => {
  it('an agent with no read-only mode: null — no checkout made, the queue reads the diff alone', async () => {
    let ran = false;
    const r = await agentInCheckout(at, 'p', { run: defaultRunner, readOnly: () => null, agent: async () => ((ran = true), 'x'), root });
    expect(r).toBeNull();
    expect(ran).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('runs the agent in the checkout with the prompt, then removes it; no answer says why', async () => {
    const seen: Array<{ prompt: string; cwd: string; claude: string }> = [];
    const io = {
      run: defaultRunner,
      readOnly: () => ({ isSettingsFile }),
      root,
      agent: async (prompt: string, cwd: string) => {
        seen.push({ prompt, cwd, claude: fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8') });
        return seen.length === 1 ? '{"stories":[]}' : null;
      },
    };
    expect(await agentInCheckout(at, 'review it', io)).toEqual({ answer: '{"stories":[]}' });
    expect(seen[0]).toMatchObject({ prompt: 'review it', claude: 'Use tabs.\n' });
    expect(fs.existsSync(seen[0].cwd)).toBe(false);
    expect(await agentInCheckout(at, 'review it', io)).toEqual({
      answer: null,
      why: `no answer: it failed or took over ${CHECKOUT_AGENT_TIMEOUT_MS / 60_000} minutes`,
    });
    expect(fs.existsSync(seen[1].cwd)).toBe(false);
    // A checkout that can't be made: said, and the agent never started.
    expect(await agentInCheckout({ ...at, number: 99 }, 'p', io)).toMatchObject({
      answer: null,
      why: expect.stringContaining("couldn't check"),
    });
    expect(seen).toHaveLength(2);
  });

  it('a run that times out: its process (working in the checkout) is killed, then the checkout is removed', async () => {
    // A made-up summarising agent whose read-only run never ends, holding the checkout as its working folder.
    const pidFile = path.join(base, 'slow.pid');
    const slow: AgentAdapter = {
      id: 'slow-reader',
      name: 'Slow reader',
      launch: {
        tool: () => ({ cmd: 'slow-reader', args: [] }),
        canResume: () => false,
        resumeLaunch: () => ({ cmd: 'slow-reader', args: [] }),
        cleanEnv: (e: NodeJS.ProcessEnv) => e,
      },
      input: { submit: async () => undefined },
      instructionsFile: 'AGENTS.md',
      oneShot: {
        command: () => ({ cmd: process.execPath, args: ['-e', ''], cwd: os.tmpdir(), env: process.env }),
        readOnly: {
          // Its pid written whole (a temp file renamed): read only once it's there, never half-written.
          command: ({ cwd }: { cwd: string }) => ({
            cmd: process.execPath,
            args: [
              '-e',
              `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid)); fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)}); setInterval(() => {}, 1000)`,
            ],
            cwd,
            env: process.env,
          }),
          isSettingsFile: isSettingsFile,
          promptLines: [],
        },
      },
    } as unknown as AgentAdapter;
    const unregister = registerAgent(slow);
    fs.mkdirSync(path.join(os.homedir(), '.work'), { recursive: true });
    fs.writeFileSync(
      path.join(os.homedir(), '.work', 'config.json'),
      JSON.stringify({ worktreesRoot: base, repos: {}, groups: {}, copyFiles: [], internalAgent: 'slow-reader' }),
    );
    let pid = 0;
    try {
      expect(internalCanRead()).toBe(true);
      let dir = '';
      const r = await agentInCheckout(at, 'p', {
        run: defaultRunner,
        readOnly: internalReadOnly,
        root,
        // Long enough for node to start and write its pid, under load too.
        agent: (p, cwd) => ((dir = cwd), runInternalReadOnly(p, cwd, 6000)),
      });
      expect(r).toMatchObject({ answer: null });
      expect(r?.why).not.toContain("wouldn't go");
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(pidFile)).toBe(true); // it ran, and wrote it whole before the timeout
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow(); // killed
      expect(worktrees()).not.toContain(path.basename(dir));
    } finally {
      // §4.6: whatever failed above, the forever child doesn't outlive the test.
      if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (pid) killTree(pid);
      unregister();
      fs.rmSync(path.join(os.homedir(), '.work', 'config.json'), { force: true });
      fs.rmSync(pidFile, { force: true });
    }
  }, 40_000);
});

describe('Git LFS stays off in the checkout (#64 F013)', () => {
  it("git worktree add runs with LFS's filter off and its smudge skipped: a PR's .lfsconfig reaches no server", async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const recording: CommandRunner = (cmd, args, cwd, env) => {
      calls.push({ args, ...(env ? { env } : {}) });
      return defaultRunner(cmd, args, cwd, env);
    };
    const t = await createReviewTree(recording, at, { root, strip: isSettingsFile });
    if (!t.ok) throw new Error(t.error);
    const add = calls.find((c) => c.args.includes('worktree') && c.args.includes('add'))!;
    expect(add.args.slice(0, add.args.indexOf('worktree'))).toEqual(expect.arrayContaining(NO_LFS));
    expect(NO_LFS).toEqual(['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false']);
    expect(add.env).toEqual(NO_LFS_ENV);
    expect(NO_LFS_ENV).toEqual({ GIT_LFS_SKIP_SMUDGE: '1' });
    expect(git(t.dir, 'rev-parse', 'HEAD')).toBe(prSha); // the checkout still made
  });

  it("the default runner sets a run's env over its own", async () => {
    const r = await defaultRunner(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.GIT_LFS_SKIP_SMUDGE ?? "unset")'],
      base,
      NO_LFS_ENV,
    );
    expect(r.stdout).toBe('1');
    const none = await defaultRunner(process.execPath, ['-e', 'process.stdout.write(process.env.GIT_LFS_SKIP_SMUDGE ?? "unset")'], base);
    expect(none.stdout).toBe(process.env.GIT_LFS_SKIP_SMUDGE ?? 'unset');
  });
});
