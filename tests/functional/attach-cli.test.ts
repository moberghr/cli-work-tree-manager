import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Functional test of the built `work attach` binary end to end: it starts a
 * detached PTY host on demand, spawns the session's tool, bridges this
 * process's stdin/stdout to it, and Ctrl+] detaches while the session keeps
 * running in the host.
 *
 * Everything runs under a throwaway HOME/USERPROFILE (os.homedir() reads
 * USERPROFILE on Windows), so the real ~/.work — with the user's live
 * sessions — is never touched. Needs `npm run build` (dist/bin.js).
 */

const BIN = path.resolve(__dirname, '../../dist/bin.js');
const ECHO_AI = path.resolve(__dirname, 'fixtures/echo-ai.cjs');
// On Windows run the tool through a .cmd shim, like npm's claude.cmd —
// the path where cmd.exe escaping matters.
const AI_COMMAND = process.platform === 'win32'
  ? path.resolve(__dirname, 'fixtures/echo-ai.cmd')
  : `node ${ECHO_AI}`;
const hasBuild = fs.existsSync(BIN);

let home: string;
let worktree: string;
let env: NodeJS.ProcessEnv;
let baseRepo: string;
let configPath: string;

function work(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf-8', timeout: 20_000 });
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  if (!hasBuild) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-home-'));
  worktree = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(worktree, { recursive: true });
  // A real git repo for `work tree base` (base checkout, no branch).
  baseRepo = path.join(home, 'repos', 'base');
  fs.mkdirSync(baseRepo, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', a, { cwd: baseRepo, encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const dotWork = path.join(home, '.work');
  fs.mkdirSync(dotWork);
  configPath = path.join(dotWork, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      worktreesRoot: path.join(home, 'wt'),
      repos: { api: worktree, base: baseRepo },
      groups: {},
      copyFiles: [],
      aiCommand: AI_COMMAND,
    }),
  );
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dotWork, 'history.json'),
    JSON.stringify([
      { target: 'api', branch: 'feat/x', isGroup: false, paths: [worktree], createdAt: now, lastAccessedAt: now },
    ]),
  );
  env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
});

afterAll(() => {
  if (!hasBuild) return;
  work(['pty-host', '--stop']);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe.skipIf(!hasBuild)('work attach (built binary, isolated HOME)', () => {
  it('attaches from the worktree dir, round-trips input, and detaches with Ctrl+]', async () => {
    const child: ChildProcess = spawn(process.execPath, [BIN, 'attach'], {
      cwd: path.join(worktree), // session resolved from cwd
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d.toString(); });
    child.stderr!.on('data', (d) => { err += d.toString(); });
    const exited = new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));

    await waitFor(() => out.includes('fake-ai ready'), 20_000, `banner (stderr: ${err})`);
    expect(out).toContain('\x1b]0;api · feat/x\x07'); // tab title = session
    child.stdin!.write('hello\r');
    await waitFor(() => out.includes('echo:hello'), 15_000, 'echo');

    child.stdin!.write('\x1d'); // Ctrl+]
    expect(await exited).toBe(0);
    expect(err).toContain('Detached');

    // The session is still alive in the host after the client left.
    const status = work(['pty-host', '--status']);
    expect(status.stderr).toMatch(/live\s+api · feat\/x/);
  });

  it('a second attach replays the screen from the first', async () => {
    const child = spawn(process.execPath, [BIN, 'attach', 'api', 'feat/x'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d.toString(); });
    child.stderr!.on('data', (d) => { err += d.toString(); });
    const exited = new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    await waitFor(() => out.includes('echo:hello'), 20_000, 'replayed echo');
    child.stdin!.write('\x1d');
    const code = await exited;
    // A quick detach used to crash on Windows (libuv assertion on exit,
    // 0xC0000409); stderr carries the assertion text if it regresses.
    expect(code, err).toBe(0);
  });

  it('pty-host --stop kills the session processes but keeps them for restore', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(home, '.work', 'pty-host.json'), 'utf-8'));
    const res = await fetch(`http://127.0.0.1:${info.port}/ptys`, { headers: { 'x-work-token': info.token } });
    const [pty] = (await res.json()) as Array<{ pid: number }>;
    expect(pty.pid).toBeGreaterThan(0);

    expect(work(['pty-host', '--stop']).status).toBe(0);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // Orphaned ConPTY children would keep running unseen and be duplicated
    // by the next restore.
    await waitFor(() => !alive(pty.pid), 10_000, 'session process to die');
    expect(fs.existsSync(path.join(home, '.work', 'pty-host.json'))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.work', 'pty-sessions.json'), 'utf-8'));
    expect(Object.keys(saved)).toHaveLength(1);
  });

  /** Run a `work` command that attaches, wait for `until`, then Ctrl+]. */
  async function runAttached(args: string[], until: (out: string) => boolean, extraEnv = {}) {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d.toString(); });
    child.stderr!.on('data', (d) => { err += d.toString(); });
    const exited = new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    await waitFor(() => until(out), 25_000, `output (stdout: ${out.slice(-300)} stderr: ${err.slice(-300)})`);
    child.stdin!.write('\x1d');
    const code = await exited;
    return { out, err, code };
  }
  const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  it("work tree --host launches in the host with the prompt and this shell's env", async () => {
    const r = await runAttached(
      ['tree', 'base', '--host', '--no-pull', '--prompt', 'hi & echo INJECTED | more'],
      (o) => o.includes('fake-ai ready'),
      { WORK_TEST_MARK: 'tree-shell' },
    );
    expect(r.code, r.err).toBe(0);
    const text = plain(r.out);
    // The prompt arrives as one literal argument — cmd.exe didn't run `&`.
    expect(text).toContain('args=[hi & echo INJECTED | more]');
    expect(text).not.toMatch(/^\s*INJECTED\s*$/m);
    expect(text).toContain('mark=[tree-shell]');
    expect(r.out).toContain('\x1b]0;base · main\x07');
    expect(work(['pty-host', '--status']).stderr).toMatch(/live\s+base · main/);
  });

  it('work tree --host on a running session attaches and says the prompt was not applied', async () => {
    const r = await runAttached(
      ['tree', 'base', '--host', '--no-pull', '--prompt', 'second'],
      (o) => plain(o).includes('fake-ai ready'), // from the replayed screen
    );
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('already running');
    expect(plain(r.out)).not.toContain('second');
  });

  it('config launchViaHost makes plain `work tree` go through the host', async () => {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, launchViaHost: true }));
    try {
      const r = await runAttached(['tree', 'base', '--no-pull'], (o) => plain(o).includes('fake-ai ready'));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain('Detached'); // it was an attach, not a direct launch
    } finally {
      fs.writeFileSync(configPath, JSON.stringify(cfg));
    }
  });

  it('fails clearly outside any session', () => {
    const r = spawnSync(process.execPath, [BIN, 'attach'], { cwd: home, env, encoding: 'utf-8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not inside a work session');
  });
});
