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
// One pair of files per server: `web` (the real one) or `web-dev` (the dev server).
type Stem = 'web' | 'web-dev';
const fileOf = (stem: Stem, ext: 'url' | 'pid') => path.join(os.homedir(), '.work', `${stem}.${ext}`);

function readUrl(stem: Stem): string | null {
  try {
    return fs.readFileSync(fileOf(stem, 'url'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function readPid(stem: Stem): number | null {
  try {
    const n = Number(fs.readFileSync(fileOf(stem, 'pid'), 'utf-8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeFiles(stem: Stem, url: string, pid: number): void {
  fs.mkdirSync(path.dirname(fileOf(stem, 'url')), { recursive: true });
  // The pid first: a server leaving at the same moment clears only files that name it,
  // so it never takes the url of the one that just started.
  fs.writeFileSync(fileOf(stem, 'pid'), String(pid));
  fs.writeFileSync(fileOf(stem, 'url'), url);
}

/**
 * Remove a server's files; with `ownerPid`, only while they still name that
 * server. `strict`: not when the pid can't be read either (the dev server's:
 * another may be writing its own).
 */
function clearFiles(stem: Stem, ownerPid?: number, strict = false): void {
  if (ownerPid !== undefined) {
    const current = readPid(stem);
    if (current === null ? strict : current !== ownerPid) return;
  }
  for (const ext of ['pid', 'url'] as const) {
    try {
      fs.unlinkSync(fileOf(stem, ext));
    } catch {
      /* already gone */
    }
  }
}

export function webUrlPath(): string {
  return fileOf('web', 'url');
}
export function webPidPath(): string {
  return fileOf('web', 'pid');
}
export const readWebUrl = (): string | null => readUrl('web');
export const readWebPid = (): number | null => readPid('web');
export const writeWebDiscovery = (url: string, pid: number): void => writeFiles('web', url, pid);

/**
 * Remove the discovery files. With `ownerPid`, only if they still name that
 * server: a new one (the desktop app restarts it at once) may have written
 * its own in the meantime, and deleting those hides it from every client —
 * `wd`, the CLI, the Claude hooks.
 */
export const clearWebDiscovery = (ownerPid?: number): void => clearFiles('web', ownerPid);

/**
 * The dev server's (`work web --dev`): a checkout's build next to the
 * installed work, found by the dev app through these files only — nothing
 * that looks for work web (`wd`, the CLI, the Claude hooks, the installed
 * app) reads them, so it never takes the dev server for the real one.
 */
export const devWebUrlPath = (): string => fileOf('web-dev', 'url');

export const writeDevWebDiscovery = (url: string, pid: number): void => writeFiles('web-dev', url, pid);
/** Remove them, only while they still name `ownerPid`. */
export const clearDevWebDiscovery = (ownerPid: number): void => clearFiles('web-dev', ownerPid, true);

/** Where the dev server stands, for `work web --dev` (start, reuse, stop). */
export type DevWebState =
  | { kind: 'running'; url: string; pid: number }
  /** Its process runs but it didn't answer in time: busy, never proof it's gone (as findHost). */
  | { kind: 'busy'; url: string; pid: number }
  | { kind: 'none' };

/**
 * The recorded dev server, only when it answers /api/context with the
 * recorded pid and says it's the dev server: files that outlived a crash
 * can name a reused pid, and their port another work web — the real one,
 * which `--dev --stop` (run by every `npm run app:dev`) would then shut
 * down. Files that name no live dev server are removed.
 */
export async function findDevWeb(probe: typeof probeWeb = probeWeb, alive: (pid: number) => boolean = isPidAlive): Promise<DevWebState> {
  const url = readUrl('web-dev');
  const pid = readPid('web-dev');
  if (!url || pid === null) return { kind: 'none' };
  if (!alive(pid)) {
    clearFiles('web-dev', pid, true);
    return { kind: 'none' };
  }
  const p = await probe(url, 3000);
  if (p.kind === 'timeout') return { kind: 'busy', url, pid };
  if (p.kind === 'ours' && p.pid === pid && p.dev) return { kind: 'running', url, pid };
  clearFiles('web-dev', pid, true);
  return { kind: 'none' };
}

export type WebProbe =
  | {
      kind: 'ours';
      pid: number | null;
      lean: boolean;
      /** null: a build before stamps. */ build: string | null;
      /** The dev server (`work web --dev`). */ dev: boolean;
    }
  /** Nothing listens there (or something that isn't work web answered). */
  | { kind: 'gone' }
  /** No answer in time — possibly just busy; never proof it's gone. */
  | { kind: 'timeout' };

export async function probeWeb(url: string, timeoutMs = 1500): Promise<WebProbe> {
  try {
    const res = await fetch(`${url}api/context`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'gone' };
    const body = (await res.json().catch(() => ({}))) as { mode?: unknown; pid?: unknown; lean?: unknown; build?: unknown; dev?: unknown };
    if (typeof body.mode !== 'string') return { kind: 'gone' };
    return {
      kind: 'ours',
      pid: typeof body.pid === 'number' ? body.pid : null,
      lean: body.lean === true,
      build: typeof body.build === 'string' ? body.build : null,
      dev: body.dev === true,
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

export type WorkWebAnswer<T> =
  { ok: true; body: T } | { ok: false; status: number; error: string } | { ok: false; status: 0; error: string };

/**
 * Call a route of the running work web (what only it can do: type into a
 * terminal it owns, start a Claude in the PTY host). Unlike askWorkWeb, a
 * refusal comes back with its reason, and "no work web" is its own answer
 * (status 0), so the caller can say how to start one.
 */
export async function callWorkWeb<T>(
  method: 'GET' | 'POST' | 'PUT',
  route: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<WorkWebAnswer<T>> {
  const url = readWebUrl();
  if (!url) return { ok: false, status: 0, error: 'work web is not running (start it with `work web`, or open the desktop app)' };
  try {
    const res = await fetch(`${url}${route.replace(/^\//, '')}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (res.ok && json) return { ok: true, body: json };
    return { ok: false, status: res.status, error: typeof json?.error === 'string' ? json.error : `work web answered ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: `work web did not answer (${(err as Error).message})` };
  }
}
