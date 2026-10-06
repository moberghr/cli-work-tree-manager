import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn, spawnSync } from 'node:child_process';

/**
 * Process lifecycle rules for the long-lived pieces (work web, the PTY
 * host), in one place — they differ on Windows in ways that bit us:
 *
 *   - Killing: process.kill on Windows is TerminateProcess of that one
 *     process — its ConPTY children (Claudes) survive, orphaned. Kill the
 *     tree with taskkill /T /F. Elsewhere SIGTERM lets the process clean up
 *     its own children.
 *   - Liveness: `process.kill(pid, 0)` works on both, but a live PID is not
 *     proof it's OURS (Windows reuses PIDs fast) — callers that act on it
 *     must also verify identity (e.g. the host's /health token check).
 *   - Detached `work` children: `detached` + `windowsHide` so no console
 *     window flashes and the child outlives the parent's terminal; output
 *     goes to a log file, never the parent's stdio.
 */

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}

/**
 * Exited, but not yet collected by its parent (a zombie): `kill(pid, 0)` still
 * succeeds, though nothing runs. A server started by a parent that never
 * waits for it — the desktop app's work web, or a test's child while the test
 * blocks in spawnSync — is one once it stops, and `work web --dev --stop`
 * waited for it to go, then said it didn't. Linux only (/proc/<pid>/stat: the
 * state letter after the command's closing parenthesis); elsewhere false.
 */
export function isZombie(pid: number, read: Pick<ProcReader, 'file'> = procFs, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  const stat = read.file(`/proc/${pid}/stat`) ?? '';
  // The state follows the command name, which is in parentheses and may hold some.
  const close = stat.lastIndexOf(')');
  return close >= 0 && stat[close + 2] === 'Z';
}

/** How /proc is read (tests pass a fake one). */
export interface ProcReader {
  link: (p: string) => string | null;
  file: (p: string) => string | null;
  pids: () => number[];
}

const procFs: ProcReader = {
  link: (p) => {
    try {
      return fs.readlinkSync(p);
    } catch {
      return null;
    }
  },
  file: (p) => {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  },
  pids: () => {
    try {
      return fs
        .readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
  },
};

const baseName = (p: string) => p.split('/').pop() || p;

/**
 * On Linux, the program a process runs, from /proc: its executable when it
 * can be read (our own processes), else its command line's first word, else
 * its `comm`. Not `ps -o comm` alone: that is its main thread's name, which
 * Node 24 sets to "MainThread" — every node process, Claude Code's included,
 * read as that, and no Claude was ever found running.
 */
export function linuxProcessName(pid: number, read: ProcReader = procFs): string | null {
  const exe = read.link(`/proc/${pid}/exe`);
  if (exe) return baseName(exe.replace(/ \(deleted\)$/, ''));
  const argv0 = (read.file(`/proc/${pid}/cmdline`) ?? '').split('\0')[0];
  if (argv0) return baseName(argv0.split(' ')[0]);
  const comm = (read.file(`/proc/${pid}/comm`) ?? '').trim();
  return comm || null;
}

/** On Linux, every process's program by pid (linuxProcessName), from /proc: no `ps` to run. */
export function linuxProcessTable(read: ProcReader = procFs): Map<number, string> {
  const out = new Map<number, string>();
  for (const pid of read.pids()) {
    const name = linuxProcessName(pid, read);
    if (name) out.set(pid, name);
  }
  return out;
}

/**
 * The executable name of a live process ("cmd.exe", "sh"), or null if it
 * isn't running or can't be read. For checking a remembered pid is still
 * the process we started before acting on it — pids get reused.
 */
export function processName(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 5000,
      });
      const m = /^"([^"]+)","(\d+)"/.exec((r.stdout ?? '').trim());
      return m && Number(m[2]) === pid ? m[1] : null;
    }
    if (process.platform === 'linux') return isPidAlive(pid) ? linuxProcessName(pid) : null;
    const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000 });
    const name = (r.stdout ?? '').trim();
    return r.status === 0 && name ? name.split('/').pop()! : null;
  } catch {
    return null;
  }
}

let recentTable: { at: number; table: Map<number, string> } | null = null;
let refreshingTable: Promise<void> | null = null;

/**
 * The process table as of at most `maxAgeMs` ago, without waiting: a stale
 * or missing one starts a background refresh (one at a time) and the last
 * one is returned — null before the first is in. For views that refresh
 * often (the session list); a decision that must be right now (is a Claude
 * already running, before starting one?) uses processTable().
 */
export function recentProcessTable(maxAgeMs: number, now = Date.now()): Map<number, string> | null {
  if (!recentTable || now - recentTable.at >= maxAgeMs) {
    refreshingTable ??= processTableAsync()
      // An empty table is a failed or timed-out listing (there is always at
      // least this process): keep the last good one, and try again next time.
      .then((table) => void (table.size > 0 && (recentTable = { at: Date.now(), table })))
      .finally(() => void (refreshingTable = null));
  }
  return recentTable?.table ?? null;
}

/** processTable(), without blocking the event loop. */
export function processTableAsync(): Promise<Map<number, string>> {
  if (process.platform === 'linux') return Promise.resolve(linuxProcessTable());
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const [cmd, args] = win ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'pid=,comm=']];
    execFile(
      cmd,
      args as string[],
      { encoding: 'utf-8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => {
        resolve(parseProcessTable(stdout ?? '', win));
      },
    );
  });
}

function parseProcessTable(stdout: string, win: boolean): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (win) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m) out.set(Number(m[2]), m[1]);
    } else {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m) out.set(Number(m[1]), m[2].trim().split('/').pop()!);
    }
  }
  return out;
}

/**
 * Every running process's executable name, by pid, in ONE call (tasklist /
 * ps) — for checking many remembered pids at once. Empty if it can't be read.
 */
export function processTable(): Map<number, string> {
  if (process.platform === 'linux') return linuxProcessTable();
  try {
    const win = process.platform === 'win32';
    const r = win
      ? spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 })
      : spawnSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf-8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    return parseProcessTable(r.stdout ?? '', win);
  } catch {
    return new Map(); // unreadable: nothing is known to be alive
  }
}

/** When this machine last booted (ms since epoch, ±1 s). */
export function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

/** Kill a process AND its children. True if the kill was delivered. */
export function killTree(pid: number): boolean {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start `node <workBin> ...args` detached, appending its output to
 * `logFile`. Returns immediately; the caller polls for readiness (a
 * discovery file / health check), because a detached child can't report
 * back directly.
 */
export function spawnDetachedWork(workBin: string, args: string[], logFile: string): void {
  const log = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [workBin, ...args], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
