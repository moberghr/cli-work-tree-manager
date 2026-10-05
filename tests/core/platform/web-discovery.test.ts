import http from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearDevWebDiscovery,
  devWebUrlPath,
  discoveryCheck,
  findDevWeb,
  existingWebDecision,
  probeWeb,
  readWebUrl,
  writeDevWebDiscovery,
} from '../../../src/core/platform/web-discovery.js';

/**
 * Deciding whether the recorded work web is still there, against real HTTP
 * servers. Getting this wrong orphaned a busy server: `wd` deleted
 * web.url, the replacement exited on the live pid, and nothing could find
 * the running one any more.
 */

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

/** A work web that answers /api/context after `delayMs`. */
async function server(delayMs: number, body: unknown = { mode: 'dashboard', pid: 1 }): Promise<string> {
  const s = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }, delayMs);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/`;
}

describe('probeWeb', () => {
  it('reports the build the server runs, or null for a build before stamps', async () => {
    expect(await probeWeb(await server(0, { mode: 'dashboard', pid: 7, lean: false, build: '1727600000000' }))).toEqual({
      kind: 'ours',
      pid: 7,
      lean: false,
      build: '1727600000000',
      dev: false,
    });
    // The dev server says so (work web --dev): its stop and reuse act only on it.
    expect(await probeWeb(await server(0, { mode: 'dashboard', pid: 8, dev: true }))).toMatchObject({ kind: 'ours', pid: 8, dev: true });
    // What a work web from before September's build stamps answers.
    expect(await probeWeb(await server(0, { mode: 'dashboard' }))).toEqual({
      kind: 'ours',
      pid: null,
      lean: false,
      build: null,
      dev: false,
    });
  });
});

describe('existingWebDecision', () => {
  it('reuses a server that answers', async () => {
    expect(await existingWebDecision(await server(0))).toBe('reuse');
  });

  it('reuses a BUSY server (slower than the first probe) instead of replacing it', async () => {
    const url = await server(2000); // past the 1.5 s probe
    expect((await probeWeb(url)).kind).toBe('timeout');
    expect(await existingWebDecision(url, { patienceMs: 8000 })).toBe('reuse');
  }, 20_000);

  it('still reuses a server that stays busy past the patience window', async () => {
    const hung = await server(60_000);
    const probe: typeof probeWeb = (url) => probeWeb(url, 100);
    expect(await existingWebDecision(hung, { patienceMs: 300, probe })).toBe('reuse');
  });

  it('starts a new one when nothing listens there any more', async () => {
    const url = await server(0);
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
    expect(await existingWebDecision(url)).toBe('start');
  });

  it('starts a new one when something that is not work web holds the port', async () => {
    expect(await existingWebDecision(await server(0, { hello: 'world' }))).toBe('start');
  });
});

describe('discoveryCheck', () => {
  const self = { pid: 100, url: 'http://127.0.0.1:1111/' };
  const other = 'http://127.0.0.1:2222/';
  const ours = (pid: number) => async () => ({ kind: 'ours' as const, pid, lean: false, build: 'b', dev: false });

  it('keeps running when web.pid names it', async () => {
    expect(await discoveryCheck(self, { readPid: () => 100 })).toBe('keep');
  });

  it('retires when another work web won the discovery files and answers as itself', async () => {
    expect(await discoveryCheck(self, { readPid: () => 200, alive: () => true, readUrl: () => other, probe: ours(200) })).toBe('retire');
  });

  it('never retires for an other that is busy, gone, or answers with another pid', async () => {
    const base = { readPid: () => 200, alive: () => true, readUrl: () => other };
    expect(await discoveryCheck(self, { ...base, probe: async () => ({ kind: 'timeout' as const }) })).toBe('keep');
    expect(await discoveryCheck(self, { ...base, probe: async () => ({ kind: 'gone' as const }) })).toBe('keep');
    expect(await discoveryCheck(self, { ...base, probe: ours(300) })).toBe('keep'); // pid reused by something else
  });

  it('writes itself back when nothing live is recorded', async () => {
    expect(await discoveryCheck(self, { readPid: () => null })).toBe('reclaim');
    expect(await discoveryCheck(self, { readPid: () => 200, alive: () => false })).toBe('reclaim');
  });
});

describe("the dev server's discovery files (work web --dev)", () => {
  afterEach(() => vi.restoreAllMocks());
  it('its own files: nothing that looks for work web finds it; cleared only by its owner', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-disc-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    writeDevWebDiscovery('http://127.0.0.1:5000/', process.pid);
    expect(fs.readFileSync(devWebUrlPath(), 'utf-8')).toBe('http://127.0.0.1:5000/');
    expect(readWebUrl()).toBeNull(); // the real work web's discovery knows nothing of it
    clearDevWebDiscovery(process.pid + 1); // someone else's: left alone
    expect(fs.existsSync(devWebUrlPath())).toBe(true);
    clearDevWebDiscovery(process.pid);
    expect(fs.existsSync(devWebUrlPath())).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('findDevWeb (work web --dev: start, reuse, stop)', () => {
  let home: string;
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const setup = () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-find-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    writeDevWebDiscovery('http://127.0.0.1:5000/', 4242);
  };
  const probe = (r: Awaited<ReturnType<typeof probeWeb>>) => async () => r;
  const ours = (pid: number, dev: boolean) => probe({ kind: 'ours', pid, lean: false, build: 'b', dev });

  it('running only when it answers with the recorded pid and says it is the dev server', async () => {
    setup();
    expect(await findDevWeb(ours(4242, true), () => true)).toEqual({ kind: 'running', url: 'http://127.0.0.1:5000/', pid: 4242 });
  });

  it('the real work web on a reused port and pid is not it: none, and the stale files go', async () => {
    setup();
    expect(await findDevWeb(ours(4242, false), () => true)).toEqual({ kind: 'none' });
    expect(fs.existsSync(devWebUrlPath())).toBe(false);
    setup();
    expect(await findDevWeb(ours(1, true), () => true)).toEqual({ kind: 'none' }); // another pid
  });

  it('a dead pid: none, and its files go; a busy one (timed out) is busy, never gone', async () => {
    setup();
    expect(await findDevWeb(ours(4242, true), () => false)).toEqual({ kind: 'none' });
    expect(fs.existsSync(devWebUrlPath())).toBe(false);
    setup();
    expect(await findDevWeb(probe({ kind: 'timeout' }), () => true)).toMatchObject({ kind: 'busy', pid: 4242 });
    expect(fs.existsSync(devWebUrlPath())).toBe(true);
  });

  it("a leaving server clears only files that name it — not a newer one's whose pid can't be read yet", () => {
    setup();
    fs.unlinkSync(path.join(home, '.work', 'web-dev.pid'));
    clearDevWebDiscovery(1);
    expect(fs.existsSync(devWebUrlPath())).toBe(true);
  });
});
