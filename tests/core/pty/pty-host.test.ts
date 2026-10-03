import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startPtyHost, type PtyHostHandle } from '../../../src/core/pty/pty-host.js';
import { PtyRegistry, type PtyLike } from '../../../src/core/pty/pty-registry.js';
import { PtyHostClient } from '../../../src/core/pty/pty-host-client.js';

class EchoPty implements PtyLike {
  readonly pty = { pid: 1 };
  exited = false;
  onExit?: (code: number) => void;
  private out?: (d: string) => void;
  setOutputHandler(h?: (d: string) => void) {
    this.out = h;
  }
  write(d: string) {
    if (d === 'quit') {
      this.exited = true;
      this.onExit?.(3);
      return;
    }
    this.out?.(`echo:${d}`);
  }
  resize() {}
  dispose() {}
}

let dir: string;
let host: PtyHostHandle;
let client: PtyHostClient;
const tool = { cmd: 'claude', baseArgs: [], unsafeFlag: '', resumeFlag: '--continue' };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-'));
  const registry = new PtyRegistry({
    spawner: () => new EchoPty(),
    hasConversation: () => false,
    sessionsPath: path.join(dir, 'pty-sessions.json'),
  });
  host = await startPtyHost({ registry, restore: false, writeInfo: false });
  client = new PtyHostClient(host.info);
});
afterEach(async () => {
  await host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function attach(id: string) {
  const ws = new WebSocket(client.attachUrl(id));
  const binary: string[] = [];
  const control: unknown[] = [];
  ws.on('message', (d, isBinary) => {
    if (isBinary) binary.push((d as Buffer).toString());
    else control.push(JSON.parse(d.toString()));
  });
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  return { ws, binary, control, opened, closed };
}
const tick = () => new Promise((r) => setTimeout(r, 50));

describe('PTY host', () => {
  it('rejects requests without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${host.info.port}/ptys`);
    expect(res.status).toBe(403);
  });

  it('spawns, lists, streams input/output and replays to a second client', async () => {
    await client.spawn('s1', { cwd: dir, tool: tool as never });
    expect((await client.list()).map((p) => p.id)).toEqual(['s1']);

    const a = attach('s1');
    await a.opened;
    a.ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await tick();
    expect(a.binary.join('')).toBe('echo:hi');

    const b = attach('s1');
    await b.opened;
    await tick();
    // Late attacher gets the screen as a replay control frame first.
    expect(b.control[0]).toEqual({ type: 'replay', data: 'echo:hi', cols: 120, rows: 32 });
    expect(b.binary.join('')).toBe('');
    expect(await client.write('s1', 'x')).toBe(true);
    await tick();
    expect(a.binary.join('')).toBe('echo:hiecho:x');
    expect(b.binary.join('')).toBe('echo:x');
    a.ws.close();
    b.ws.close();
  });

  it('sends an exit control frame and closes when the PTY exits', async () => {
    await client.spawn('s2', { cwd: dir, tool: tool as never });
    const a = attach('s2');
    await a.opened;
    a.ws.send(JSON.stringify({ type: 'input', data: 'quit' }));
    await a.closed;
    expect(a.control.at(-1)).toEqual({ type: 'exit', code: 3 });
  });

  it('refuses a spawn whose cwd does not exist', async () => {
    await expect(client.spawn('s3', { cwd: path.join(dir, 'nope'), tool: tool as never })).rejects.toThrow(/cwd/);
  });
});

describe('startup restore ordering (reviewed bug)', () => {
  it('saved sessions are restored before the host serves anything — a spawn right after start cannot drop them', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-restore-'));
    const sessionsPath = path.join(d, 'pty-sessions.json');
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        x: { cwd: d, tool, startedAt: '' },
        z: { cwd: d, tool, startedAt: '' },
      }),
    );
    const registry = new PtyRegistry({ spawner: () => new EchoPty(), hasConversation: () => false, sessionsPath, cwdExists: () => true });
    const h = await startPtyHost({ registry, writeInfo: false }); // restore: default (during startup)
    const c = new PtyHostClient(h.info);
    await c.spawn('y', { cwd: d, tool: tool as never }); // the very first request
    await registry.flush();
    expect(Object.keys(JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))).sort()).toEqual(['x', 'y', 'z']);
    await h.stop();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('`work pty-host` restores inside its start lock (not after releasing it)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/commands/pty-host.ts'), 'utf-8');
    expect(src).not.toMatch(/restore:\s*false/);
    expect(src).not.toMatch(/registry\.restore\(\)/);
  });
});
