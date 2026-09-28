import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How everything finds the running `work web` (the singleton): the
 * `web.url` + `web.pid` files it writes in ~/.work. One module instead of
 * copies in the web command, `wd`, and the Claude hook bridge.
 *
 * The files outlive the process (crash, kill, reboot) and Windows reuses
 * PIDs, so neither file is proof of anything: `probeWeb` asks the server
 * itself, and it answers /api/context with its own pid.
 */

// os.homedir() per call (not getConfigDir, which creates the dir): tests
// mock homedir, and readers must not create ~/.work as a side effect.
export function webUrlPath(): string {
  return path.join(os.homedir(), '.work', 'web.url');
}
export function webPidPath(): string {
  return path.join(os.homedir(), '.work', 'web.pid');
}

export function readWebUrl(): string | null {
  try {
    return fs.readFileSync(webUrlPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function readWebPid(): number | null {
  try {
    const n = Number(fs.readFileSync(webPidPath(), 'utf-8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeWebDiscovery(url: string, pid: number): void {
  fs.mkdirSync(path.dirname(webUrlPath()), { recursive: true });
  fs.writeFileSync(webUrlPath(), url);
  fs.writeFileSync(webPidPath(), String(pid));
}

export function clearWebDiscovery(): void {
  try { fs.unlinkSync(webPidPath()); } catch { /* already gone */ }
  try { fs.unlinkSync(webUrlPath()); } catch { /* already gone */ }
}

export type WebProbe =
  | { kind: 'ours'; pid: number | null }
  /** Nothing listens there (or something that isn't work web answered). */
  | { kind: 'gone' }
  /** No answer in time — possibly just busy; never proof it's gone. */
  | { kind: 'timeout' };

export async function probeWeb(url: string, timeoutMs = 1500): Promise<WebProbe> {
  try {
    const res = await fetch(`${url}api/context`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'gone' };
    const body = (await res.json().catch(() => ({}))) as { mode?: unknown; pid?: unknown };
    if (typeof body.mode !== 'string') return { kind: 'gone' };
    return { kind: 'ours', pid: typeof body.pid === 'number' ? body.pid : null };
  } catch (err) {
    const name = (err as { name?: string }).name;
    return name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'gone' };
  }
}

/**
 * Liveness only: is a server serving the recorded URL (any 2xx at
 * api/context)? Enough for "reuse it / autostart one". Identity — is it
 * work web, with the recorded pid — is probeWeb's job, and only matters
 * before killing something.
 */
export async function webServerResponds(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}api/context`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
