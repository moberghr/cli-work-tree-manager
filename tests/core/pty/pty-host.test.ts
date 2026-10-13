import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { isTerminalReply, startPtyHost, type PtyHostHandle } from '../../../src/core/pty/pty-host.js';
import { PtyRegistry, type PtyLike } from '../../../src/core/pty/pty-registry.js';
import { PtyHostClient } from '../../../src/core/pty/pty-host-client.js';

class EchoPty implements PtyLike {
  readonly pty = { pid: 1 };
  exited = false;
  /** What reached it, in order: writes and resizes. */
  readonly log: string[] = [];
  onExit?: (code: number) => void;
  private out?: (d: string) => void;
  setOutputHandler(h?: (d: string) => void) {
    this.out = h;
  }
  write(d: string) {
    this.log.push(`write ${d}`);
    if (d === 'quit') {
      this.exited = true;
      this.onExit?.(3);
      return;
    }
    this.out?.(`echo:${d}`);
  }
  resize(cols: number, rows: number) {
    this.log.push(`resize ${cols}x${rows}`);
  }
  dispose() {
    if (this.exited) return;
    this.exited = true;
    this.onExit?.(0);
  }
}

/** Every PTY the host spawned, newest last. */
const spawned: EchoPty[] = [];
let dir: string;
let host: PtyHostHandle;
let client: PtyHostClient;
const tool = { cmd: 'claude', baseArgs: [], unsafeFlag: '', resumeFlag: '--continue' };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-'));
  const registry = new PtyRegistry({
    spawner: () => {
      const p = new EchoPty();
      spawned.push(p);
      return p;
    },
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

  it('the client used last sets the size: typing in a terminal brings the PTY back to its grid after the app resized it', async () => {
    await client.spawn('s4', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1)!;
    const terminal = attach('s4');
    const app = attach('s4');
    await Promise.all([terminal.opened, app.opened]);
    terminal.ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
    await tick();
    app.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 })); // the session opened in the app
    await tick();
    expect(pty.log.at(-1)).toBe('resize 90x30');
    terminal.ws.send(JSON.stringify({ type: 'input', data: 'k' }));
    await tick();
    // Its grid first, so the agent redraws for the terminal it's typed in, then the keys.
    expect(pty.log.slice(-2)).toEqual(['resize 200x50', 'write k']);
    terminal.ws.send(JSON.stringify({ type: 'input', data: 'j' }));
    await tick();
    expect(pty.log.at(-1)).toBe('write j'); // the same grid: nothing to resize
    app.ws.send(JSON.stringify({ type: 'input', data: 'x' }));
    await tick();
    expect(pty.log.slice(-2)).toEqual(['resize 90x30', 'write x']);
    // The terminal answering a query, or losing focus, isn't someone using it: the grid stays the app's.
    terminal.ws.send(JSON.stringify({ type: 'input', data: '\x1b[O' }));
    terminal.ws.send(JSON.stringify({ type: 'input', data: '\x1b[?62;22c' }));
    await tick();
    expect(pty.log.slice(-2)).toEqual(['write \x1b[O', 'write \x1b[?62;22c']);
    terminal.ws.close();
    app.ws.close();
  });

  it('a terminal reply is told from typing', () => {
    for (const reply of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[12;40R',
      '\x1b[0n',
      '\x1b[?1u',
      '\x1b[?2004;1$y',
      '\x1b[8;50;200t',
      '\x1b]11;rgb:0000/0000/0000\x1b\\',
      '\x1b]10;rgb:ffff/ffff/ffff\x07',
      '\x1bP>|xterm.js\x1b\\',
      '\x1b[O\x1b[I',
      '\x1b[<35;10;5M', // the mouse moving, no button down (hovering)
      '\x1b[<39;10;5M\x1b[<35;11;5M', // …with Shift, then without
    ])
      expect(isTerminalReply(reply), JSON.stringify(reply)).toBe(true);
    for (const typed of [
      'k',
      '\r',
      '\x1b',
      '\x1b[A',
      '\x1b[200~paste\x1b[201~',
      '\x1b[<0;10;5M', // a click
      '\x1b[<32;12;5M', // a drag (left button down)
      '\x1b[1;2R', // Shift+F3, not a cursor report
      '\x1b[1;5R', // Ctrl+F3
      '\x1b[O' + 'k',
      '\x03',
    ])
      expect(isTerminalReply(typed), JSON.stringify(typed)).toBe(false);
  });

  it('restart: a new agent in place, the attached terminals kept and not told the old one ended', async () => {
    await client.spawn('s5', { cwd: dir, tool: tool as never });
    const before = spawned.at(-1)!;
    const a = attach('s5');
    await a.opened;
    expect(await client.restart('s5')).toBe('restarted');
    const after = spawned.at(-1)!;
    expect(after).not.toBe(before);
    expect(before.exited).toBe(true);
    a.ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await tick();
    expect(after.log).toContain('write hi'); // typed into the new one
    expect(a.binary.join('')).toContain('echo:hi');
    expect(a.control.filter((f) => (f as { type: string }).type === 'exit')).toEqual([]);
    expect((await client.list()).find((p) => p.id === 's5')).toMatchObject({ exited: false, clients: 1 });
    expect(await client.restart('nope')).toBe('not-running');
    a.ws.close();
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
