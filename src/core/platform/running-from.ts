import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { killTree } from './process.js';

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
  if (!INTERPRETERS.has(bare(exe || p.name))) return false;
  const script = words.slice(1).find((w) => !w.startsWith('-'));
  return !!script && /[\\/]/.test(script) && dirs.some((d) => under(script, d, windows));
}

/** It names one of `dirs` somewhere in its command line or executable path. */
export function mentions(p: RunningProcess, dirs: string[], windows = win): boolean {
  const norm = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
  const text = `${norm(p.exe ?? '')} ${norm(p.command)}`;
  return dirs.some((d) => text.includes(d));
}

export interface Holders {
  /** Run from the folders: stop these (each the top of its tree — its children go with it). */
  stoppable: RunningProcess[];
  /** Name the folders but run from elsewhere (an editor, a shell): the user's to close. */
  others: RunningProcess[];
}

/**
 * What runs from or names `dirs`, in `procs`. Never this process or one it
 * runs under (work web, the PTY host's chain), whatever their command lines say.
 */
export function holdersOf(procs: RunningProcess[], dirs: string[], self = process.pid, windows = win): Holders {
  const norm = dirs.map((d) => normDir(d, windows));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const mine = new Set<number>();
  for (let pid: number | undefined = self; pid && !mine.has(pid); pid = byPid.get(pid)?.ppid) mine.add(pid);
  const candidates = procs.filter((p) => !mine.has(p.pid));
  const running = candidates.filter((p) => runsFrom(p, norm, windows));
  const runningPids = new Set(running.map((p) => p.pid));
  return {
    stoppable: running.filter((p) => !runningPids.has(p.ppid)),
    others: candidates.filter((p) => !runningPids.has(p.pid) && mentions(p, norm, windows)),
  };
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

function linuxProcesses(): RunningProcess[] {
  const out: RunningProcess[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const d of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const command = fs
        .readFileSync(`/proc/${d}/cmdline`, 'utf-8')
        .split('\0')
        .filter(Boolean)
        .map((w) => (/\s/.test(w) ? `"${w}"` : w))
        .join(' ');
      let exe: string | null = null;
      try {
        exe = fs.readlinkSync(`/proc/${d}/exe`);
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
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ]),
    );
  }
  return parsePsProcesses(await run('ps', ['-A', '-o', 'pid=,ppid=,args=']));
}

/** Look up what runs from or names `dirs` now. */
export async function findHolders(dirs: string[], list: () => Promise<RunningProcess[]> = listProcesses): Promise<Holders> {
  const existing = dirs.filter((d) => fs.existsSync(d));
  if (existing.length === 0) return { stoppable: [], others: [] };
  return holdersOf(await list(), existing);
}

/**
 * Stop what runs from `dirs` (each tree), and say what: ["node …\vite\bin\vite.js --mode demo (PID 35464)"].
 * Only processes whose program is in the folders — never an editor open on them.
 */
export async function stopRunningFrom(
  dirs: string[],
  io: { list?: () => Promise<RunningProcess[]>; kill?: (pid: number) => boolean } = {},
): Promise<string[]> {
  const { stoppable } = await findHolders(dirs, io.list);
  const kill = io.kill ?? killTree;
  const norm = dirs.map((d) => normDir(d));
  return stoppable.filter((p) => kill(p.pid)).map((p) => describeProcess(p, norm));
}
