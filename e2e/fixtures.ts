import { test as base } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

/**
 * Isolation: every `work` process an e2e test starts gets HOME and
 * USERPROFILE pointed at a fresh temp dir (os.homedir() reads USERPROFILE
 * on Windows, HOME elsewhere). So ~/.work (config, history, web.url,
 * pty-host.json, pty-sessions.json) and ~/.claude (hooks, transcripts)
 * are the temp ones — the developer's real sessions are never touched.
 *
 * Claude is replaced by e2e/fake-ai.cjs via `aiCommand`, so a test never
 * starts a real agent.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BIN = path.join(REPO_ROOT, 'dist', 'bin.js');
const FAKE_AI = path.join(HERE, 'fake-ai.cjs');
// Shared with the functional tests: a stand-in `gh` (pr view/create/merge).
const FAKE_GH = path.join(REPO_ROOT, 'tests', 'functional', 'fixtures', 'fake-gh.cjs');

export interface PtyInfo {
  id: string;
  pid: number;
  exited: boolean;
  restored: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

/** Strip ANSI/OSC escapes so a serialized screen can be text-matched. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '');
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WorkEnv {
  readonly home: string;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  url = '';
  private web: ChildProcess | null = null;
  private seenPids = new Set<number>();
  private hostPids = new Set<number>();

  constructor() {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-e2e-'));
    this.repo = path.join(this.home, 'repos', 'app');
    // A fake `gh` first on PATH, so Ship never talks to GitHub.
    const bin = path.join(this.home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'gh.cmd'), `@node "${FAKE_GH}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(this.home, 'empty.gitconfig'), '');
    this.env = {
      ...process.env,
      HOME: this.home,
      USERPROFILE: this.home,
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
      // An empty git config, never the developer's (commit signing through
      // an agent can block a commit indefinitely) — see tests/setup/isolate-git.ts.
      GIT_CONFIG_GLOBAL: path.join(this.home, 'empty.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
      PATH: bin + path.delimiter + (process.env.PATH ?? ''),
      FAKE_GH_LOG: path.join(this.home, 'gh.log'),
      FAKE_GH_STATE: path.join(this.home, 'gh-state.json'),
    };
  }

  /** Every `gh` invocation the fake recorded (argv arrays). */
  ghCalls(): string[][] {
    const log = path.join(this.home, 'gh.log');
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Every session as work web reports it (archived ones included). */
  async sessions(): Promise<Array<{ target: string; branch: string; archivedAt: string | null }>> {
    const res = await fetch(new URL('api/sessions', this.url));
    return ((await res.json()) as { sessions: Array<{ target: string; branch: string; archivedAt: string | null }> }).sessions;
  }

  /** Commit a file in a worktree (so there's something to ship). */
  commitIn(branch: string, file: string, content: string): void {
    const cwd = this.worktreePath(branch);
    fs.writeFileSync(path.join(cwd, file), content);
    for (const args of [['add', '.'], ['commit', '-q', '-m', `edit ${file}`]]) {
      const r = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
        cwd,
        env: this.env,
        encoding: 'utf-8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    }
  }

  get workDir(): string {
    return path.join(this.home, '.work');
  }

  /** Temp git repo with one commit, config pointing at it, and one
   *  `work tree --setup-only` worktree session per branch. */
  setup(branches: string[]): void {
    this.initRepo(this.repo);
    this.writeConfig({ app: this.repo }, {});
    for (const b of branches) this.work(['tree', 'app', b, '--setup-only', '--no-pull']);
  }

  /** A two-repo group `shop` (backend + frontend) with one group worktree
   *  for `branch` — the multi-repo case ship has to be careful with. */
  setupGroup(branch: string): void {
    const repos = { backend: path.join(this.home, 'repos', 'backend'), frontend: path.join(this.home, 'repos', 'frontend') };
    for (const p of Object.values(repos)) this.initRepo(p);
    this.writeConfig(repos, { shop: ['backend', 'frontend'] });
    this.work(['tree', 'shop', branch, '--setup-only', '--no-pull']);
  }

  /** Where `work tree shop <branch>` put a sub-repo. */
  groupWorktreePath(branch: string, repo: string): string {
    return path.join(this.home, 'worktrees', 'shop', branch.replace(/\//g, '-'), repo);
  }

  /** Commit a file in any checkout. */
  commitAt(cwd: string, file: string, content: string): void {
    fs.writeFileSync(path.join(cwd, file), content);
    for (const args of [['add', '.'], ['commit', '-q', '-m', `edit ${file}`]]) {
      const r = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
        cwd,
        env: this.env,
        encoding: 'utf-8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    }
  }

  /** A git repo with one commit and a bare "origin" (so Ship can push and
   *  origin/HEAD resolves). */
  private initRepo(repo: string): void {
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
        cwd: repo,
        env: this.env,
        encoding: 'utf-8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${path.basename(repo)}\n`);
    git('add', '.');
    git('commit', '-m', 'init');
    const origin = path.join(this.home, 'origins', `${path.basename(repo)}.git`);
    const bare = spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: this.env, encoding: 'utf-8' });
    if (bare.status !== 0) throw new Error(`git init --bare: ${bare.stderr}`);
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
    git('remote', 'set-head', 'origin', 'main');
  }

  private writeConfig(repos: Record<string, string>, groups: Record<string, string[]>): void {
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.workDir, 'config.json'),
      JSON.stringify(
        {
          worktreesRoot: path.join(this.home, 'worktrees'),
          repos,
          groups,
          copyFiles: [],
          aiCommand: `node ${FAKE_AI.replace(/\\/g, '/')}`,
        },
        null,
        2,
      ),
    );
  }

  work(args: string[]): string {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      env: this.env,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (r.status !== 0) {
      throw new Error(`work ${args.join(' ')} exited ${r.status}: ${r.stderr}\n${r.stdout}`);
    }
    return r.stdout + r.stderr;
  }

  /** Where `work tree app <branch>` put the worktree. */
  worktreePath(branch: string): string {
    return path.join(this.home, 'worktrees', path.basename(this.repo), branch.replace(/\//g, '-'));
  }

  /** Fire a Claude hook the way Claude Code does: `work hook <event>` with
   *  the hook payload as JSON on stdin (cwd inside the worktree). */
  hook(event: string, payload: Record<string, unknown>): void {
    const r = spawnSync(process.execPath, [BIN, 'hook', event], {
      env: this.env,
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (r.status !== 0) throw new Error(`work hook ${event} exited ${r.status}: ${r.stderr}`);
  }

  sessionId(target: string, branch: string): string {
    return crypto.createHash('sha1').update(`${target}:${branch}`).digest('hex').slice(0, 12);
  }

  async startWeb(): Promise<string> {
    const urlFile = path.join(this.workDir, 'web.url');
    try { fs.unlinkSync(urlFile); } catch { /* */ }
    const log = fs.openSync(path.join(this.home, 'web.log'), 'a');
    this.web = spawn(process.execPath, [BIN, 'web', '--no-open'], {
      env: this.env,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    this.url = await until('work web url', async () => {
      const u = fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf-8').trim() : '';
      if (!u) return null;
      const res = await fetch(u + 'api/context');
      return res.ok ? u : null;
    });
    return this.url;
  }

  async stopWeb(): Promise<void> {
    const child = this.web;
    this.web = null;
    spawnSync(process.execPath, [BIN, 'web', '--stop'], { env: this.env, stdio: 'ignore' });
    if (child?.pid && child.exitCode === null) {
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
      if (child.exitCode === null) killTree(child.pid);
    }
  }

  hostInfo(): { pid: number; port: number; token: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.workDir, 'pty-host.json'), 'utf-8'));
    } catch {
      return null;
    }
  }

  async listPtys(): Promise<PtyInfo[]> {
    const info = this.hostInfo();
    if (!info) return [];
    this.hostPids.add(info.pid);
    const res = await fetch(`http://127.0.0.1:${info.port}/ptys`, {
      headers: { 'x-work-token': info.token },
      signal: AbortSignal.timeout(2000),
    });
    const ptys = (await res.json()) as PtyInfo[];
    for (const p of ptys) this.seenPids.add(p.pid);
    return ptys;
  }

  async waitForPty(id: string, pred: (p: PtyInfo) => boolean = (p) => !p.exited): Promise<PtyInfo> {
    return until(`pty ${id}`, async () => (await this.listPtys()).find((p) => p.id === id && pred(p)));
  }

  /**
   * The PTY's current screen as plain text — read straight from the PTY
   * host (attach, take the serialized replay frame, detach). The browser
   * renders xterm to a WebGL canvas, so the DOM has no text to assert on;
   * the host's headless mirror is the same screen the browser draws.
   */
  async screen(id: string): Promise<string> {
    const info = this.hostInfo();
    if (!info) return '';
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ptys/${id}/attach?token=${info.token}`);
    try {
      const frame = await new Promise<{ type: string; data?: string }>((resolve, reject) => {
        ws.on('message', (d, isBinary) => {
          if (!isBinary) resolve(JSON.parse(d.toString()));
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no replay frame')), 3000);
      });
      return frame.type === 'replay' ? plainText(frame.data ?? '') : '';
    } finally {
      ws.close();
    }
  }

  async waitForScreen(id: string, needle: string): Promise<string> {
    return until(`"${needle}" on screen of ${id}`, async () => {
      const s = await this.screen(id);
      return s.includes(needle) ? s : null;
    });
  }

  stopHost(): void {
    const info = this.hostInfo();
    if (info) this.hostPids.add(info.pid);
    spawnSync(process.execPath, [BIN, 'pty-host', '--stop'], { env: this.env, stdio: 'ignore' });
  }

  async waitForDead(pid: number): Promise<void> {
    await until(`pid ${pid} to exit`, () => !isAlive(pid), 10_000);
  }

  async dispose(): Promise<void> {
    await this.stopWeb().catch(() => {});
    this.stopHost();
    // Host killed with TerminateProcess can orphan its ConPTY children.
    for (const pid of [...this.hostPids, ...this.seenPids]) if (isAlive(pid)) killTree(pid);
    await sleep(300);
    fs.rmSync(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export const test = base.extend<{ work: WorkEnv }>({
  work: async ({}, use) => {
    const env = new WorkEnv();
    try {
      await use(env);
    } finally {
      await env.dispose();
    }
  },
});

export { expect } from '@playwright/test';
