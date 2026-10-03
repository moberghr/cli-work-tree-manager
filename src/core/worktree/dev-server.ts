import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfigDir, type WorkConfig } from '../platform/config.js';
import { bootTime, isPidAlive, killTree, processName } from '../platform/process.js';
import { json, withDb } from '../platform/db.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import type { DevServerState } from '../api-types.js';

/**
 * Per-worktree dev server + preview.
 *
 * Every worktree already owns a stable port ($PORT, see port-allocator.ts)
 * that its Claude and anything it runs inherit. This module answers "is
 * something serving on it?" and can run the repo's dev command there —
 * `devCommands` in config.json, keyed by repo alias, e.g.
 * `{ "web": "npm run dev -- --port $PORT" }`. In a group the first repo
 * (in the session's order) with a command gets the port.
 *
 * The command comes from the user's own config and runs with `shell: true`
 * (like statusHooks); the worktree path is the spawn cwd, never part of
 * the command string. It runs in the background, its output in
 * ~/.work/dev/<session>.log, its pid in state.db (`dev_runs`) — so a
 * `work web` restart still knows it and can stop it.
 */

function devDir(): string {
  const dir = path.join(getConfigDir(), 'dev');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const devLogFile = (id: string) => path.join(devDir(), `${id}.log`);

interface RunRecord {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  /** Executable at that pid when we started it (the shell), if known.
   *  Records from before this field (imported from the JSON files) have
   *  none, and are trusted on pid + boot alone. */
  image?: string | null;
}

/** A run started this close to a boot can't be told from one started
 *  before it, if the clock was stepped meanwhile (NTP after sleep). */
const REBOOT_SLACK_MS = 5 * 60_000;

function isRunRecord(x: unknown): x is RunRecord {
  const r = x as RunRecord | null;
  return !!r && typeof r === 'object' && typeof r.pid === 'number' && typeof r.command === 'string' && typeof r.startedAt === 'string';
}

/** The machine has rebooted since this run started, so its pid — if alive —
 *  belongs to someone else (Windows reuses pids quickly). Compares the boot
 *  time with the run's own start time, both on the wall clock, so a clock
 *  step of a few minutes doesn't turn a live run into "another boot". */
function rebootedSince(r: RunRecord): boolean {
  const started = Date.parse(r.startedAt);
  if (!Number.isFinite(started)) return true; // unknown start: don't trust it
  return bootTime() - started > REBOOT_SLACK_MS;
}

/**
 * The live run for a session, or null. A saved pid is trusted only while
 * it is alive and from this boot: after a reboot the row survives but the
 * number may belong to an unrelated process — which the header would show
 * as "running" and Stop would kill.
 */
function readRun(id: string): RunRecord | null {
  const row = withDb((d) => d.prepare('SELECT data FROM dev_runs WHERE session_id = ?').get(id) as { data: string } | undefined);
  if (!row) return null;
  const r = json.parse(row.data);
  if (isRunRecord(r) && !rebootedSince(r) && isPidAlive(r.pid)) return r;
  forgetRun(id); // it died on its own, or the machine rebooted
  return null;
}

function forgetRun(id: string): void {
  withDb((d) => d.prepare('DELETE FROM dev_runs WHERE session_id = ?').run(id));
}

/** The dev command for this session and where it runs, or null. */
export function devCommandFor(
  session: WorktreeSession,
  config: Pick<WorkConfig, 'repos' | 'groups' | 'devCommands'> | null,
): { command: string; cwd: string; repo: string } | null {
  const commands = config?.devCommands ?? {};
  const aliases = session.isGroup ? (config?.groups?.[session.target] ?? []) : [session.target];
  for (const p of session.paths) {
    // A worktree folder is named after its repo's folder (resolve.ts), so
    // match the alias by the repo path's basename.
    const alias = aliases.find((a) => {
      const repo = config?.repos?.[a];
      return repo !== undefined && path.basename(repo).toLowerCase() === path.basename(p).toLowerCase();
    }) ?? (session.isGroup ? undefined : session.target);
    const command = alias ? commands[alias] : undefined;
    if (alias && typeof command === 'string' && command.trim()) return { command, cwd: p, repo: alias };
  }
  return null;
}

/** Something accepts TCP connections on localhost:port (IPv4 or IPv6). */
export function isListening(port: number, timeoutMs = 400): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  return probe('127.0.0.1').then((ok) => ok || probe('::1'));
}

export async function devState(
  id: string,
  session: WorktreeSession,
  config: Pick<WorkConfig, 'repos' | 'groups' | 'devCommands'> | null,
): Promise<DevServerState> {
  const port = session.port ?? null;
  const cmd = devCommandFor(session, config);
  const run = readRun(id);
  return {
    port,
    listening: port !== null ? await isListening(port) : false,
    url: port !== null ? `http://localhost:${port}/` : null,
    command: cmd?.command ?? null,
    repo: cmd?.repo ?? null,
    running: run ? { pid: run.pid, startedAt: run.startedAt } : null,
  };
}

export type DevStartOutcome = { ok: true; pid: number } | { ok: false; status: 400 | 409; error: string };

export function startDev(
  id: string,
  session: WorktreeSession,
  config: Pick<WorkConfig, 'repos' | 'groups' | 'devCommands'> | null,
): DevStartOutcome {
  if (session.port === undefined) return { ok: false, status: 400, error: 'this worktree has no port — recreate it with work tree' };
  const cmd = devCommandFor(session, config);
  if (!cmd) return { ok: false, status: 400, error: 'no dev command — set devCommands in ~/.work/config.json' };
  if (!fs.existsSync(cmd.cwd)) return { ok: false, status: 400, error: `worktree is gone: ${cmd.cwd}` };
  const running = readRun(id);
  if (running) return { ok: false, status: 409, error: `already running (pid ${running.pid})` };

  const log = fs.openSync(devLogFile(id), 'w');
  try {
    fs.writeSync(log, `$ ${cmd.command}   (PORT=${session.port}, in ${cmd.cwd})\n`);
    const child = spawn(cmd.command, {
      cwd: cmd.cwd,
      shell: true,
      // POSIX: its own process group, so Stop can signal the whole tree.
      // Windows: NOT detached — a DETACHED_PROCESS cmd.exe drops its
      // children's output — and taskkill /T stops the tree instead.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: String(session.port) },
    });
    child.on('error', () => {});
    if (child.pid === undefined) return { ok: false, status: 400, error: 'could not start the dev command' };
    child.unref();
    const rec: RunRecord = {
      pid: child.pid,
      command: cmd.command,
      cwd: cmd.cwd,
      startedAt: new Date().toISOString(),
      image: processName(child.pid),
    };
    withDb((d) => d.prepare('INSERT OR REPLACE INTO dev_runs (session_id, data) VALUES (?, ?)').run(id, JSON.stringify(rec)));
    return { ok: true, pid: child.pid };
  } finally {
    fs.closeSync(log);
  }
}

/** Stop this session's dev server (the whole process tree). `name` looks
 *  up a live pid's executable (injectable for tests). */
export function stopDev(id: string, name: (pid: number) => string | null = processName): boolean {
  const run = readRun(id);
  if (!run) return false;
  // Last check before killing a whole tree: the pid must still be the shell
  // we started. A DIFFERENT program at that number means the dev server is
  // long gone and the pid was reused — forget it, kill nothing. An
  // unreadable name (tasklist/ps slow or missing) proves nothing: the pid
  // is alive and from this boot, so go ahead.
  const now = name(run.pid);
  if (run.image && now !== null && now.toLowerCase() !== run.image.toLowerCase()) {
    forgetRun(id);
    return false;
  }
  // Detached on POSIX = its own process group: signal the group, so the
  // shell's children (npm → vite) go too. Windows: taskkill /T.
  let killed = false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-run.pid, 'SIGTERM');
      killed = true;
    } catch {
      /* fall through */
    }
  }
  if (!killed) killed = killTree(run.pid);
  forgetRun(id);
  return killed;
}

/** The tail of the dev server's log. */
export function devLogTail(id: string, maxBytes = 64 * 1024): string {
  try {
    const file = devLogFile(id);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
