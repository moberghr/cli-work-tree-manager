import fs from 'node:fs';
import path from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import { getConfigDir } from './config.js';
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

async function health(info: HostInfo, timeoutMs = 800): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { 'x-work-token': info.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: number };
    return typeof body.version === 'number' ? body.version : null;
  } catch {
    return null;
  }
}

/** The running host, or null. Throws PtyHostVersionError on a mismatch. */
export async function findHost(): Promise<HostInfo | null> {
  const info = readHostInfo();
  if (!info) return null;
  const version = await health(info);
  if (version === null) return null;
  if (version !== PROTOCOL_VERSION) throw new PtyHostVersionError(version);
  return info;
}

/**
 * Return the running host, spawning a detached one if none is. `workBin` is
 * the path to the `work` binary (dist/bin.js) — passed in rather than
 * derived because core can't reach the commands layer's resolver (§2.1).
 * Concurrent callers may both spawn; the loser's `work pty-host` sees the
 * winner via the discovery file and exits.
 */
export async function ensureHost(workBin: string, timeoutMs = 8000): Promise<HostInfo> {
  const existing = await findHost();
  if (existing) return existing;

  const log = fs.openSync(path.join(getConfigDir(), 'pty-host.log'), 'a');
  const child = childSpawn(process.execPath, [workBin, 'pty-host'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const found = await findHost().catch(() => null);
    if (found) return found;
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
