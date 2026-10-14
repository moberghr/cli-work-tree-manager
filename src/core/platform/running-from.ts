import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isPidAlive, killTreeAsync } from './process.js';
import { packageRoot } from './package-root.js';
import { getConfigDir } from './config.js';

/**
 * Processes running from a folder — a dev server, a watcher, a built app
 * Claude started in a worktree — and what keeps a folder in use on Windows.
 * Archiving stops Claude, but not what it started in the background (`vite`
 * with `run_in_background`): that held a file in `node_modules`, so git
 * removed the worktree only in part, and Restore couldn't move what was left.
 *
 * Two kinds, kept apart on purpose:
 *   - runs from it: its program is in the folder — the executable, or an
 *     interpreter's script (`node <dir>/node_modules/vite/bin/vite.js`,
 *     `dotnet <dir>/bin/App.dll`). Work's to stop, with the session's work.
 *   - mentions it: anything else naming the folder (an editor opened on it,
 *     a terminal). Named in a message, never stopped: it's the user's.
 */

export interface RunningProcess {
  pid: number;
  ppid: number;
  /** Its executable's file name ("node.exe"). */
  name: string;
  /** Its executable's full path, when the system says. */
  exe: string | null;
  /** Its command line ('' when it can't be read). */
  command: string;
}

/** Interpreters whose script is the program: the first argument that isn't an option. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'pythonw', 'py', 'dotnet', 'java', 'javaw', 'ruby', 'php']);

const win = process.platform === 'win32';

/** A path as compared: absolute, normalised, `\` and case-blind on Windows. */
export function normDir(p: string, windows = win): string {
  if (windows) return path.win32.normalize(p.replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();
  return path.posix.normalize(p).replace(/\/+$/, '');
}

function under(p: string, dir: string, windows: boolean): boolean {
  const a = normDir(p, windows);
  const sep = windows ? '\\' : '/';
  return a === dir || a.startsWith(dir + sep);
}

/** A command line's words: quotes group, and are dropped (Windows' rules, roughly; enough to find a path). */
export function commandWords(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

const bare = (file: string) =>
  file
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');

/** Its program is in one of `dirs` (normalised with normDir): the executable, or an interpreter's script. */
export function runsFrom(p: RunningProcess, dirs: string[], windows = win): boolean {
  const words = commandWords(p.command);
  const exe = p.exe ?? words[0] ?? '';
  if (exe && dirs.some((d) => under(exe, d, windows))) return true;
  // Its version gone: python3.12, node22 (Linux names the binary itself).
  if (!INTERPRETERS.has(bare(exe || p.name).replace(/[\d.]+$/, ''))) return false;
  // Its script: the first argument that isn't an option, or any that names a program file (an option's value comes
  // first in `node -r ts-node/register <dir>/src/index.ts`).
  const args = words.slice(1);
  const first = args.find((w) => !w.startsWith('-'));
  const scripts = [first, ...args.filter((w) => SCRIPT_FILE.test(w))].filter((w): w is string => !!w && /[\\/]/.test(w));
  return scripts.some((w) => dirs.some((d) => under(w, d, windows)));
}

const SCRIPT_FILE = /\.(c|m)?(js|ts)$|\.(py|dll|jar|rb|php)$/i;

/** node-pty's own processes (the console it gives a terminal): work's, when it runs from a checkout. */
export function isPtyHelper(p: RunningProcess): boolean {
  return /[\\/]node-pty[\\/]/i.test(`${p.exe ?? ''} ${p.command}`) || /^(conpty|openconsole|winpty-agent)(\.exe)?$/i.test(p.name);
}

/** Where this work runs from: its `dist/bin.js` (an npm install, a linked checkout, the desktop app's copy). */
export function workBinPaths(): string[] {
  const root = packageRoot();
  return root ? [normDir(path.join(root, 'dist', 'bin.js'))] : [];
}

/**
 * One of work's own (the PTY host, a work web, a hook): this work's own `bin.js` running one of those — never
 * stopped, wherever it's installed (stopping the PTY host stops every session's Claude). Not any `bin.js web`:
 * a project's own would be spared, and keep its worktree in use.
 */
export function isWorkProcess(p: RunningProcess, bins: string[] = workBinPaths(), windows = win): boolean {
  if (bins.length === 0) return false;
  const raw = commandWords(p.command);
  return raw.some((w, i) => /^(pty-host|web|hook)$/.test(raw[i + 1] ?? '') && bins.includes(normDir(w, windows)));
}

/** It names one of `dirs` somewhere in its command line or executable path. */
export function mentions(p: RunningProcess, dirs: string[], windows = win): boolean {
  const norm = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
  const text = `${norm(p.exe ?? '')} ${norm(p.command)}`;
  // The folder itself, or inside it: anything but more of a name may follow (a separator, a quote, `&`, `;`, the
  // end) — not feat-x2 or feat-x-old, which are other folders.
  return dirs.some((d) => {
    for (let at = text.indexOf(d); at >= 0; at = text.indexOf(d, at + 1)) {
      const next = text[at + d.length];
      if (next === undefined || !/[\w.-]/.test(next)) return true;
    }
    return false;
  });
}

export interface Holders {
  /** Run from the folders: stop these (each the top of its tree — its children go with it on Windows). */
  stoppable: RunningProcess[];
  /** Every one that runs from them, children too: POSIX kills one process at a time. */
  running?: RunningProcess[];
  /** Name the folders but run from elsewhere (an editor, a shell): the user's to close. */
  others: RunningProcess[];
}

/**
 * What runs from or names `dirs`, in `procs`. Never this process or one it runs under, never one in `spare` (the
 * PTY host and work web by their recorded pids) or under it, and never one of work's own by its command line
 * (isWorkProcess) — whatever folder they run from.
 */
export function holdersOf(
  procs: RunningProcess[],
  dirs: string[],
  self = process.pid,
  windows = win,
  spare: ReadonlySet<number> = new Set(),
  bins: string[] = workBinPaths(),
): Holders {
  const norm = dirs.map((d) => normDir(d, windows));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const mine = new Set<number>();
  for (let pid: number | undefined = self; pid && !mine.has(pid); pid = byPid.get(pid)?.ppid) mine.add(pid);
  // work's own (by pid or command line), and the terminal helpers they run (node-pty's, from where work is
  // installed — a checkout's node_modules). Not everything under them: a dev server a Claude started is a
  // descendant of the PTY host until that Claude is gone, and stopping it is the point.
  const ownWork = (q: RunningProcess) => spare.has(q.pid) || isWorkProcess(q, bins, windows);
  const spared = (p: RunningProcess): boolean => {
    if (ownWork(p)) return true;
    if (!isPtyHelper(p)) return false;
    const seen = new Set<number>();
    for (let q = byPid.get(p.ppid); q && !seen.has(q.pid); q = byPid.get(q.ppid)) {
      if (ownWork(q)) return true;
      seen.add(q.pid);
    }
    return false;
  };
  const candidates = procs.filter((p) => !mine.has(p.pid) && !spared(p));
  const running = candidates.filter((p) => runsFrom(p, norm, windows));
  const runningPids = new Set(running.map((p) => p.pid));
  return {
    stoppable: running.filter((p) => !runningPids.has(p.ppid)),
    running,
    others: candidates.filter((p) => !runningPids.has(p.pid) && mentions(p, norm, windows)),
  };
}

/** The pids work recorded for its PTY host and work web (and the dev server's): spared by every stop. */
export function workPids(dir = getConfigDir()): Set<number> {
  const out = new Set<number>();
  for (const file of ['pty-host.json', 'web.pid', 'web-dev.pid']) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
      const pid = raw.startsWith('{') ? (JSON.parse(raw) as { pid?: unknown }).pid : Number(raw.split(/\s/)[0]);
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) out.add(pid);
    } catch {
      /* not running, or not recorded */
    }
  }
  return out;
}

/** "node …\vite\bin\vite.js --mode demo (PID 35464)": its name and command, the folder shortened to "…". */
export function describeProcess(p: RunningProcess, dirs: string[], windows = win): string {
  const words = commandWords(p.command).slice(1);
  let args = words.join(' ');
  // The folder (normalised as normDir: `\`, lower case on Windows) wherever it appears, as typed.
  for (const d of dirs) {
    const fold = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
    for (let at = fold(args).indexOf(d); at >= 0; at = fold(args).indexOf(d)) args = args.slice(0, at) + '…' + args.slice(at + d.length);
  }
  if (args.length > 90) args = `${args.slice(0, 89)}…`;
  const name = bare(p.name || p.exe || '?');
  return `${name}${args ? ` ${args}` : ''} (PID ${p.pid})`;
}

/** Windows: `Get-CimInstance Win32_Process` as JSON (one object, or a list). */
export function parseCimProcesses(json: string): RunningProcess[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const out: RunningProcess[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.ProcessId !== 'number') continue;
    out.push({
      pid: o.ProcessId,
      ppid: typeof o.ParentProcessId === 'number' ? o.ParentProcessId : 0,
      name: typeof o.Name === 'string' ? o.Name : '',
      exe: typeof o.ExecutablePath === 'string' ? o.ExecutablePath : null,
      command: typeof o.CommandLine === 'string' ? o.CommandLine : '',
    });
  }
  return out;
}

/** macOS: `ps -A -o pid=,ppid=,args=`. */
export function parsePsProcesses(stdout: string): RunningProcess[] {
  const out: RunningProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[3].trim();
    const first = commandWords(command)[0] ?? '';
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: path.posix.basename(first),
      exe: first.startsWith('/') ? first : null,
      command,
    });
  }
  return out;
}

/** Read asynchronously: work web's requests wait behind a synchronous walk of /proc. */
async function linuxProcesses(): Promise<RunningProcess[]> {
  const out: RunningProcess[] = [];
  let pids: string[];
  try {
    pids = (await fs.promises.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const d of pids) {
    try {
      const stat = await fs.promises.readFile(`/proc/${d}/stat`, 'utf-8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const command = (await fs.promises.readFile(`/proc/${d}/cmdline`, 'utf-8'))
        .split('\0')
        .filter(Boolean)
        .map((w) => (/\s/.test(w) ? `"${w}"` : w))
        .join(' ');
      let exe: string | null = null;
      try {
        exe = await fs.promises.readlink(`/proc/${d}/exe`);
      } catch {
        /* another user's */
      }
      out.push({ pid: Number(d), ppid, name: exe ? path.posix.basename(exe) : '', exe, command });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) =>
      resolve(stdout ?? ''),
    ),
  );

/** Every process with its parent, executable and command line. Empty when they can't be read. */
export async function listProcesses(): Promise<RunningProcess[]> {
  if (process.platform === 'linux') return linuxProcesses();
  if (process.platform === 'win32') {
    return parseCimProcesses(
      await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // UTF-8 out: the console's code page would turn a path with Š or č into ?.
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ]),
    );
  }
  return parsePsProcesses(await run('ps', ['-A', '-o', 'pid=,ppid=,args=']));
}

/** Look up what runs from or names `dirs` now. */
export async function findHolders(
  dirs: string[],
  list: () => Promise<RunningProcess[]> = listProcesses,
  spare: ReadonlySet<number> = workPids(),
): Promise<Holders> {
  const existing = dirs.filter((d) => fs.existsSync(d));
  if (existing.length === 0) return { stoppable: [], running: [], others: [] };
  return holdersOf(await list(), existing, process.pid, win, spare);
}

/** How long a stop waits for what it stopped to be gone (its files let go) before going on. */
const EXIT_WAIT_MS = 3000;

/**
 * Stop what runs from `dirs`, and say what: ["node …\vite\bin\vite.js --mode demo (PID 35464)"]. Only processes
 * whose program is in the folders — never an editor open on them, never one of work's own. Windows stops each
 * tree; POSIX each process (a kill there is one process). Waits a moment for them to be gone, so the folder is
 * free when it returns.
 */
export async function stopRunningFrom(
  dirs: string[],
  io: {
    list?: () => Promise<RunningProcess[]>;
    kill?: (pid: number) => Promise<boolean> | boolean;
    alive?: (pid: number) => boolean;
    spare?: ReadonlySet<number>;
    waitMs?: number;
  } = {},
): Promise<string[]> {
  const h = await findHolders(dirs, io.list, io.spare);
  const kill = io.kill ?? killTreeAsync;
  const alive = io.alive ?? isPidAlive;
  const targets = win ? h.stoppable : (h.running ?? h.stoppable);
  // All at once, and off the event loop (taskkill takes a few hundred ms each; work web answers meanwhile).
  const killed = await Promise.all(targets.map((p) => Promise.resolve(kill(p.pid)).catch(() => false)));
  const stopped = targets.filter((_, i) => killed[i]);
  for (const until = Date.now() + (io.waitMs ?? EXIT_WAIT_MS); stopped.some((p) => alive(p.pid)) && Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const norm = dirs.map((d) => normDir(d));
  const named = new Set(h.stoppable.map((p) => p.pid));
  return stopped.filter((p) => named.has(p.pid)).map((p) => describeProcess(p, norm));
}
