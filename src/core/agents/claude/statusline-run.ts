import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../../platform/config.js';
import { detachHere, killTree } from '../../platform/process.js';
import spawn from '../../platform/spawn.js';

// The status-line hook's half of statusline.ts: what runs on every refresh of every Claude. Light on purpose — no
// settings editor, no locks, no registry; installing and removing the wrapper is statusline.ts.

export const WORK_STATUSLINE = 'work hook statusline';
/** Set on the user's own command: a status line that runs work's hook again (it called `work hook statusline` itself) records, and runs nothing more. */
export const NESTED_ENV = 'WORK_STATUSLINE_NESTED';

export type StatusLine = Record<string, unknown>;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const savedPath = () => path.join(getConfigDir(), 'statusline.json');

/**
 * work's hook under any path (`/usr/bin/work hook statusline`, `node …/bin.js hook statusline`), with or without the
 * user's line after `||` as its fallback: saved as "the original", it would run itself.
 */
export const isOurs = (v: unknown) => isRecord(v) && typeof v.command === 'string' && /\bhook\s+statusline\b/.test(v.command);

/** What ~/.work/statusline.json says: an original (null: there was none), nothing saved, or a file that can't be read. */
export type Saved = { kind: 'ok'; original: StatusLine | null } | { kind: 'missing' } | { kind: 'unreadable'; why: string };

export function readSaved(): Saved {
  let text: string;
  try {
    text = fs.readFileSync(savedPath(), 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', why: code ?? String(e) };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { kind: 'unreadable', why: e instanceof Error ? e.message : String(e) };
  }
  if (!isRecord(v) || !('original' in v)) return { kind: 'unreadable', why: 'no original in it' };
  if (v.original === null) return { kind: 'ok', original: null };
  return isRecord(v.original) ? { kind: 'ok', original: v.original } : { kind: 'unreadable', why: 'original is not an object' };
}

/** The user's own status line command, when they had one. `onDamage` hears why a saved file couldn't be read. */
export function originalStatusLine(onDamage?: (why: string) => void): { command: string } | null {
  const saved = readSaved();
  if (saved.kind === 'unreadable') onDamage?.(saved.why);
  const o = saved.kind === 'ok' ? saved.original : null;
  return o && typeof o.command === 'string' && o.command ? { command: o.command } : null;
}

/** The shell Claude Code runs a status line in: sh on POSIX, Git Bash on Windows. */
export function shellFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): { file: string; args: (cmd: string) => string[] } {
  const args = (cmd: string) => ['-c', cmd];
  if (platform !== 'win32') return { file: '/bin/sh', args };
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured && exists(configured)) return { file: configured, args };
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    if (!exists(path.win32.join(dir, 'git.exe'))) continue;
    for (const bash of [path.win32.join(dir, '..', 'bin', 'bash.exe'), path.win32.join(dir, 'bash.exe')])
      if (exists(bash)) return { file: bash, args };
  }
  const standard = 'C:\\Program Files\\Git\\bin\\bash.exe';
  return { file: exists(standard) ? standard : 'bash', args };
}

const OUTPUT_CAP = 64 * 1024;
/** After the command exits, how long what it printed may still be on its way: its stdout can stay open past its exit. */
const EXIT_GRACE_MS = 100;

/** Stop the command and whatever it started: its process group on POSIX (a `cmd &` holding stdout keeps no hook alive), taskkill /T on Windows. */
function killCommand(pid: number): void {
  if (detachHere()) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* no group (it wasn't detached, or has gone): the process alone */
    }
  }
  killTree(pid);
}

/** Run the user's own status line with Claude's JSON on stdin. Its output, or '' when it fails or takes too long: never rejects. */
export function runStatusLineCommand(cmd: string, stdin: string, o: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const out: Buffer[] = [];
    let outBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // Let go of it: a pipe still held by something it started would keep this process (Claude's hook) alive past its cap.
      child?.stdout?.destroy();
      child?.stdin?.destroy();
      child?.unref();
      resolve(ok ? Buffer.concat(out).subarray(0, OUTPUT_CAP).toString('utf-8') : '');
    };
    try {
      const sh = shellFor();
      child = spawn(sh.file, sh.args(cmd), {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        cwd: o.cwd,
        // Its own process group on POSIX, so a timeout stops what it started too.
        detached: detachHere(),
        // Marked, so a command that runs work's hook again doesn't run itself (runStatusLineHook).
        env: { ...process.env, [NESTED_ENV]: '1' },
      });
      const c = child;
      timer = setTimeout(() => {
        if (c.pid) killCommand(c.pid);
        finish(false);
      }, o.timeoutMs ?? 5000);
      c.on('error', () => finish(false));
      c.stdout?.on('data', (d: Buffer) => {
        if (outBytes >= OUTPUT_CAP) return;
        out.push(d);
        outBytes += d.length;
      });
      // 'close' waits for stdout to end, and something the command left running (`cmd &`) holds it: the line would wait
      // for the cap, and be lost. Its exit decides; what it printed is read until stdout ends, or a moment more.
      c.on('exit', (code) => {
        if (code !== 0) finish(false);
        else grace ??= setTimeout(() => finish(true), EXIT_GRACE_MS);
      });
      c.on('close', (code) => finish(code === 0));
      c.stdin?.on('error', () => {
        /* it exited before reading: its exit code decides */
      });
      c.stdin?.end(stdin);
    } catch {
      finish(false);
    }
  });
}
