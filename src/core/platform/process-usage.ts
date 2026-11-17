import { execFile } from 'node:child_process';
import path from 'node:path';
import { programPath } from './program-path.js';
import { commandWords, type RunningProcess } from './running-from.js';

/**
 * Every process with what it holds: its memory and when it started, beside its parent and command line
 * (running-from.ts) — for saying what a session's agent and the things it started cost (session-processes.ts).
 * Read asynchronously, in one call (Windows: about a second). Empty when the processes can't be read.
 */
export interface ProcessUsage extends RunningProcess {
  /** The memory it holds for itself (Windows: private bytes; elsewhere: resident), or null when the system didn't say. */
  memBytes: number | null;
  /** When it started (ms since the epoch), or null when the system didn't say. */
  startedAt: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Windows: `Get-CimInstance Win32_Process` with `PrivatePageCount` and `Started` (ms), as JSON (one object, or a list). Pure. */
export function parseCimUsage(json: string): ProcessUsage[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const out: ProcessUsage[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.ProcessId !== 'number') continue;
    const started = num(o.Started);
    out.push({
      pid: o.ProcessId,
      ppid: typeof o.ParentProcessId === 'number' ? o.ParentProcessId : 0,
      name: typeof o.Name === 'string' ? o.Name : '',
      exe: typeof o.ExecutablePath === 'string' ? o.ExecutablePath : null,
      command: typeof o.CommandLine === 'string' ? o.CommandLine : '',
      memBytes: num(o.PrivatePageCount),
      // 0: a system process with no creation date.
      startedAt: started ? started : null,
    });
  }
  return out;
}

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in ms; null when it isn't one. Pure. */
export function elapsedMs(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

/** macOS and Linux: `ps -A -o pid=,ppid=,rss=,etime=,args=` (rss in KB). Pure (`now` for the start time). */
export function parsePsUsage(stdout: string, now: number): ProcessUsage[] {
  const out: ProcessUsage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[5].trim();
    const first = commandWords(command)[0] ?? '';
    const elapsed = elapsedMs(m[4]);
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: path.posix.basename(first),
      exe: first.startsWith('/') ? first : null,
      command,
      memBytes: Number(m[3]) * 1024,
      startedAt: elapsed === null ? null : now - elapsed,
    });
  }
  return out;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(
      programPath(cmd),
      args,
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ?? ''),
    ),
  );

/** The PowerShell that lists them (UTF-8 out: the console's code page would turn a path with Š or č into ?). */
const CIM_USAGE =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,PrivatePageCount,' +
  "@{n='Started';e={ if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }} | ConvertTo-Json -Compress";

/** Every process with its memory and start time. Empty when they can't be read. */
export async function listProcessUsage(now = Date.now()): Promise<ProcessUsage[]> {
  if (process.platform === 'win32') return parseCimUsage(await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM_USAGE]));
  return parsePsUsage(await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,etime=,args=']), now);
}
