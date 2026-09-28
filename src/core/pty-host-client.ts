import fs from 'node:fs';
import path from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import { getConfigDir } from './config.js';
import { ensureFile, withFileLock } from './fs-safe.js';
import {
  PROTOCOL_VERSION,
  readHostInfo,
  type HostInfo,
  type PtyInfo,
  type SpawnSpec,
} from './pty-host-protocol.js';

export class PtyHostVersionError extends Error {
  constructor(readonly hostVersion: number) {
    super(
      `A PTY host from an older build (protocol v${hostVersion}, need v${PROTOCOL_VERSION}) ` +
        'is running. Restart it with `work pty-host --restart` — sessions come back via --continue.',
    );
  }
}

/**
 * Ask whoever listens on the discovery file's port whether it's our host:
 * it must answer /health with our token. Returns what it reports (its
 * protocol version and pid), or null if nothing answers / the token is
 * wrong — i.e. the discovery file is stale.
 */
export async function probeHost(
  info: HostInfo,
  timeoutMs = 800,
): Promise<{ version: number; pid: number } | null> {
  const r = await probeHostDetailed(info, timeoutMs);
  return r.kind === 'host' ? { version: r.version, pid: r.pid } : null;
}

export type ProbeResult =
  | { kind: 'host'; version: number; pid: number }
  /** Nothing listens on the port (connection refused): definitely gone. */
  | { kind: 'refused' }
  /** Something answered, but not as our host (wrong token, bad body). */
  | { kind: 'not-ours' }
  /** No answer in time — could be a BUSY host (e.g. restoring many
   *  sessions). Never treat this as proof the host is gone. */
  | { kind: 'timeout' };

export async function probeHostDetailed(info: HostInfo, timeoutMs = 800): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { 'x-work-token': info.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { kind: 'not-ours' };
    const body = (await res.json()) as { version?: number; pid?: number };
    if (typeof body.version !== 'number' || typeof body.pid !== 'number') return { kind: 'not-ours' };
    return { kind: 'host', version: body.version, pid: body.pid };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    if (e.cause?.code === 'ECONNREFUSED') return { kind: 'refused' };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'refused' };
  }
}

/** The running host, or null. Throws PtyHostVersionError on a mismatch. */
export async function findHost(): Promise<HostInfo | null> {
  const info = readHostInfo();
  if (!info) return null;
  const probe = await probeHost(info);
  if (!probe || probe.pid !== info.pid) return null;
  if (probe.version !== PROTOCOL_VERSION) throw new PtyHostVersionError(probe.version);
  return info;
}

/** Serializes host spawning across `work` processes (see ensureHost). */
export function hostSpawnLockPath(): string {
  return path.join(getConfigDir(), 'pty-host.spawn.lock');
}

let inFlight: Promise<HostInfo> | null = null;

/**
 * Return the running host, spawning a detached one if none is. `workBin` is
 * the path to the `work` binary (dist/bin.js) — passed in rather than
 * derived because core can't reach the commands layer's resolver (§2.1).
 *
 * Exactly one host may start: two hosts would each restore every saved
 * session — two Claudes on one conversation. So spawning is single-flight
 * within this process (concurrent callers share one attempt) and serialized
 * across processes by a file lock held from "is one running?" until the new
 * host answers; a caller that waited on the lock re-checks and finds it.
 */
// A cold host start loads the whole `work` bundle; on a busy machine (right
// after login with autostart, or a loaded test run) that can pass 8 s.
export function ensureHost(workBin: string, timeoutMs = 20_000): Promise<HostInfo> {
  if (!inFlight) {
    inFlight = ensureHostLocked(workBin, timeoutMs).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function ensureHostLocked(workBin: string, timeoutMs: number): Promise<HostInfo> {
  const existing = await findHost();
  if (existing) return existing;
  const lock = hostSpawnLockPath();
  ensureFile(lock, '');
  try {
    return await withFileLock(lock, async () => {
      // Another process may have started it while we waited for the lock.
      const started = await findHost();
      if (started) return started;
      spawnHost(workBin);
      return waitForHost(timeoutMs);
    });
  } catch (err) {
    // Couldn't get the lock in time (another process is mid-spawn and slow):
    // don't spawn a second one — wait for theirs.
    if ((err as { code?: string }).code === 'ELOCKED') return waitForHost(timeoutMs);
    throw err;
  }
}

function spawnHost(workBin: string): void {
  const log = fs.openSync(path.join(getConfigDir(), 'pty-host.log'), 'a');
  const child = childSpawn(process.execPath, [workBin, 'pty-host'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);
}

async function waitForHost(timeoutMs: number): Promise<HostInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findHost().catch(() => null);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('PTY host did not start (see ~/.work/pty-host.log)');
}

export class PtyHostClient {
  constructor(readonly info: HostInfo) {}

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.info.port}${p}`, {
      method,
      headers: {
        'x-work-token': this.info.token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `PTY host ${method} ${p}: ${res.status}`);
    return json;
  }

  list(): Promise<PtyInfo[]> {
    return this.call('GET', '/ptys');
  }

  get(id: string): Promise<PtyInfo | null> {
    return this.call<PtyInfo>('GET', `/ptys/${encodeURIComponent(id)}`).catch(() => null);
  }

  spawn(id: string, spec: SpawnSpec): Promise<PtyInfo> {
    return this.call('POST', `/ptys/${encodeURIComponent(id)}`, spec);
  }

  async write(id: string, data: string): Promise<boolean> {
    try {
      await this.call('POST', `/ptys/${encodeURIComponent(id)}/write`, { data });
      return true;
    } catch {
      return false;
    }
  }

  async kill(id: string): Promise<void> {
    await this.call('DELETE', `/ptys/${encodeURIComponent(id)}`);
  }

  attachUrl(id: string): string {
    return `ws://127.0.0.1:${this.info.port}/ptys/${encodeURIComponent(id)}/attach?token=${this.info.token}`;
  }
}
