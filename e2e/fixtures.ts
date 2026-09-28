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
    this.env = {
      ...process.env,
      HOME: this.home,
      USERPROFILE: this.home,
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  get workDir(): string {
    return path.join(this.home, '.work');
  }

  /** Temp git repo with one commit, config pointing at it, and one
   *  `work tree --setup-only` worktree session per branch. */
  setup(branches: string[]): void {
    fs.mkdirSync(this.repo, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
        cwd: this.repo,
        env: this.env,
        encoding: 'utf-8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-b', 'main');
    fs.writeFileSync(path.join(this.repo, 'README.md'), '# app\n');
    git('add', '.');
    git('commit', '-m', 'init');

    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.workDir, 'config.json'),
      JSON.stringify(
        {
          worktreesRoot: path.join(this.home, 'worktrees'),
          repos: { app: this.repo },
          groups: {},
          copyFiles: [],
          aiCommand: `node ${FAKE_AI.replace(/\\/g, '/')}`,
        },
        null,
        2,
      ),
    );
    for (const b of branches) this.work(['tree', 'app', b, '--setup-only', '--no-pull']);
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
