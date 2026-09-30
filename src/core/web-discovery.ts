import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from './process.js';

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

/**
 * Remove the discovery files. With `ownerPid`, only if they still name that
 * server: a new one (the desktop app restarts it at once) may have written
 * its own in the meantime, and deleting those hides it from every client —
 * `wd`, the CLI, the Claude hooks.
 */
export function clearWebDiscovery(ownerPid?: number): void {
  if (ownerPid !== undefined) {
    const current = readWebPid();
    if (current !== null && current !== ownerPid) return;
  }
  try { fs.unlinkSync(webPidPath()); } catch { /* already gone */ }
  try { fs.unlinkSync(webUrlPath()); } catch { /* already gone */ }
}

export type WebProbe =
  | { kind: 'ours'; pid: number | null; lean: boolean; /** null: a build before stamps. */ build: string | null }
  /** Nothing listens there (or something that isn't work web answered). */
  | { kind: 'gone' }
  /** No answer in time — possibly just busy; never proof it's gone. */
  | { kind: 'timeout' };

export async function probeWeb(url: string, timeoutMs = 1500): Promise<WebProbe> {
  try {
    const res = await fetch(`${url}api/context`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'gone' };
    const body = (await res.json().catch(() => ({}))) as { mode?: unknown; pid?: unknown; lean?: unknown; build?: unknown };
    if (typeof body.mode !== 'string') return { kind: 'gone' };
    return {
      kind: 'ours',
      pid: typeof body.pid === 'number' ? body.pid : null,
      lean: body.lean === true,
      build: typeof body.build === 'string' ? body.build : null,
    };
  } catch (err) {
    const name = (err as { name?: string }).name;
    return name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'gone' };
  }
}

/**
 * What to do with the recorded work web before starting one:
 *   - 'reuse'  it answered as work web — or it is BUSY (timed out, possibly
 *              more than once): a slow server is still the running one, and
 *              replacing it orphans it (the new one sees the live pid and
 *              exits; the old one keeps the port and hooks but can no longer
 *              be found once web.url is gone).
 *   - 'start'  nothing is there any more (the url file is stale).
 * Busy servers get `patienceMs` of re-probing before being reused anyway.
 */
export async function existingWebDecision(
  url: string,
  opts: { patienceMs?: number; probe?: typeof probeWeb } = {},
): Promise<'reuse' | 'start'> {
  const probe = opts.probe ?? probeWeb;
  const until = Date.now() + (opts.patienceMs ?? 6000);
  for (let first = true; ; first = false) {
    const r = await probe(url, first ? 1500 : 3000);
    if (r.kind === 'ours') return 'reuse';
    if (r.kind === 'gone') return 'start';
    if (Date.now() >= until) return 'reuse';
  }
}

/**
 * A running work web checks, now and then, that it is still THE one:
 *   - 'keep'    web.pid names us.
 *   - 'retire'  web.pid names another work web that answers as itself: two
 *               were started at once (a restart racing the desktop app's
 *               watchdog, which starts one when none answers) and the other
 *               won the discovery files. Ours can no longer be found, but it
 *               kept its PR watch and gh calls going — twice the GitHub API
 *               use — and the desktop app stayed on it, an old build.
 *   - 'reclaim' nothing recorded (or a dead pid): write ours back, so `wd`,
 *               the app and `work web --stop` find the one that runs.
 * A busy or silent other is never reason to retire (see existingWebDecision).
 */
export async function discoveryCheck(
  self: { pid: number; url: string },
  deps: { readPid?: () => number | null; readUrl?: () => string | null; alive?: (pid: number) => boolean; probe?: typeof probeWeb } = {},
): Promise<'keep' | 'retire' | 'reclaim'> {
  const pid = (deps.readPid ?? readWebPid)();
  if (pid === self.pid) return 'keep';
  const alive = deps.alive ?? isPidAlive;
  if (pid === null || !alive(pid)) return 'reclaim';
  const url = (deps.readUrl ?? readWebUrl)();
  if (!url || url === self.url) return 'keep';
  const r = await (deps.probe ?? probeWeb)(url, 3000);
  return r.kind === 'ours' && r.pid === pid ? 'retire' : 'keep';
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

/**
 * GET a JSON route from the running work web, for what only it holds (the
 * PR watch's cache, which PTYs are live). Null when none runs or it doesn't
 * answer in time: callers go without that part rather than fail.
 */
export async function askWorkWeb<T>(route: string, timeoutMs = 3000): Promise<T | null> {
  const url = readWebUrl();
  if (!url) return null;
  try {
    const res = await fetch(`${url}${route.replace(/^\//, '')}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
