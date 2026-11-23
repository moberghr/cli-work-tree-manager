import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startPtyHost, type PtyHostHandle } from '../../../src/core/pty/pty-host.js';
import { PtyRegistry, type PtyLike } from '../../../src/core/pty/pty-registry.js';
import { isTerminalReply, replyParts } from '../../../src/core/pty/terminal-replies.js';
import { ScreenMirror } from '../../../src/core/pty/screen-mirror.js';
import type { TerminalColors } from '../../../src/core/pty/terminal-colors.js';
import { PtyHostClient } from '../../../src/core/pty/pty-host-client.js';
import { VERSION } from '../../../src/version.js';

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

/** A PTY with a real copy of its screen (ScreenMirror), passing the agent's output on as PtySession does. */
class MirrorPty implements PtyLike {
  readonly pty = { pid: 2 };
  exited = false;
  /** What reached the agent, in order. */
  readonly got: string[] = [];
  onExit?: (code: number) => void;
  readonly mirror = new ScreenMirror(120, 32);
  private out?: (d: string) => void;
  setOutputHandler(h?: (d: string) => void) {
    this.out = h;
  }
  write(d: string) {
    this.got.push(d);
  }
  resize(cols: number, rows: number) {
    this.mirror.resize(cols, rows);
  }
  dispose() {
    if (this.exited) return;
    this.exited = true;
    this.mirror.dispose();
    this.onExit?.(0);
  }
  serialize() {
    return this.mirror.snapshot();
  }
  serializeSettled() {
    return this.mirror.snapshotSettled();
  }
  answerQueries(now: () => boolean, colors: Pick<TerminalColors, 'reply'>) {
    this.mirror.answerQueries({ now, colors, send: (reply) => this.write(reply) });
  }
  /** The agent printed `data`: to the screen's copy, then to the host (PtySession's onData). */
  print(data: string) {
    this.mirror.write(data);
    this.out?.(data);
  }
}

/** Every PTY the host spawned, newest last. */
const spawned: PtyLike[] = [];
/** What the host spawns: an echo, unless a test wants a screen. */
let makePty: () => PtyLike = () => new EchoPty();
let dir: string;
let host: PtyHostHandle;
let client: PtyHostClient;
const tool = { cmd: 'claude', baseArgs: [], resumeFlag: '--continue' };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-'));
  const registry = new PtyRegistry({
    spawner: () => {
      const p = makePty();
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

  it('says what it supports on /health (the accounts agentEnv, halt / resume): clients ask before relying on them', async () => {
    expect(await client.features()).toEqual(['agentEnv', 'halt', 'tickets']);
  });

  it('says on /health which release it runs (it outlives updates: the dashboard says when it is older)', async () => {
    expect(await client.workVersion()).toBe(VERSION);
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

  it('a dashboard page attaches with a one-time ticket work web got for its origin — never the token', async () => {
    await client.spawn('s1', { cwd: dir, tool: tool as never });
    const page = 'http://127.0.0.1:54989';
    const url = (await client.ticketUrl('s1', page))!;
    expect(url).toMatch(/\/ptys\/s1\/attach\?ticket=[0-9a-f]{48}$/);
    expect(url).not.toContain(host.info.token);
    // The page's own origin, as a browser sends it: it attaches and streams like any client.
    const open = (u: string, origin: string) => {
      const ws = new WebSocket(u, { headers: { Origin: origin } });
      const binary: string[] = [];
      ws.on('message', (d, isBinary) => isBinary && binary.push((d as Buffer).toString()));
      return {
        ws,
        binary,
        result: new Promise<'open' | 'refused'>((r) => {
          ws.on('open', () => r('open'));
          ws.on('error', () => r('refused'));
        }),
      };
    };
    const a = open(url, page);
    expect(await a.result).toBe('open');
    await tick();
    a.ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await tick();
    expect(a.binary.join('')).toBe('echo:hi');
    a.ws.close();
    // Once: the same ticket again is refused.
    expect(await open(url, page).result).toBe('refused');
    // Another origin, or no ticket and no token: refused.
    expect(await open((await client.ticketUrl('s1', page))!, 'http://127.0.0.1:1').result).toBe('refused');
    expect(await open(`ws://127.0.0.1:${host.info.port}/ptys/s1/attach`, page).result).toBe('refused');
    // A ticket for one terminal doesn't open another.
    await client.spawn('s2', { cwd: dir, tool: tool as never });
    expect(await open((await client.ticketUrl('s1', page))!.replace('/s1/', '/s2/'), page).result).toBe('refused');
    // Only for a page on this machine; and only work web, with the token, can ask for one.
    expect(await client.ticketUrl('s1', 'https://evil.example')).toBeNull();
    const asked = await fetch(`http://127.0.0.1:${host.info.port}/tickets`, {
      method: 'POST',
      body: JSON.stringify({ id: 's1', origin: page }),
    });
    expect(asked.status).toBe(403);
  });

  it('stops with a terminal still attached — a dashboard tab connected straight here never closes on its own', async () => {
    await client.spawn('s1', { cwd: dir, tool: tool as never });
    const page = 'http://127.0.0.1:54989';
    const ws = new WebSocket((await client.ticketUrl('s1', page))!, { headers: { Origin: page } });
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    const stopped = await Promise.race([host.stop().then(() => 'stopped'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(stopped).toBe('stopped');
    await closed; // the tab saw its connection end (and reconnects to the next host)
    // afterEach stops it again: a second stop must not throw.
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
    const pty = spawned.at(-1) as EchoPty;
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
    // The terminal answering a query, or losing focus, isn't someone using it: the grid stays the app's. Its answer
    // doesn't reach the agent either: the app, used last, answers (terminal-rendering.md, "Who answers a query").
    terminal.ws.send(JSON.stringify({ type: 'input', data: '\x1b[O' }));
    terminal.ws.send(JSON.stringify({ type: 'input', data: '\x1b[?62;22c' }));
    await tick();
    expect(pty.log.slice(-2)).toEqual(['write x', 'write \x1b[O']);
    app.ws.send(JSON.stringify({ type: 'input', data: '\x1b[?1;2c' }));
    await tick();
    expect(pty.log.slice(-2)).toEqual(['write \x1b[O', 'write \x1b[?1;2c']);
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
      '\x1b[?12;40R', // DECXCPR
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
    const before = spawned.at(-1) as EchoPty;
    const a = attach('s5');
    await a.opened;
    expect(await client.restart('s5')).toBe('restarted');
    const after = spawned.at(-1) as EchoPty;
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

  it('restart with an agent environment: the host takes it (echoes it applied) and restarts in place; a malformed one is ignored', async () => {
    await client.spawn('s6', { cwd: dir, tool: tool as never, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/old' } });
    const before = spawned.at(-1) as EchoPty;
    expect(await client.restart('s6', { agentEnv: { CLAUDE_CONFIG_DIR: '/acc/new' } })).toBe('restarted');
    expect(before.exited).toBe(true);
    expect(spawned.at(-1)).not.toBe(before);
    // Over the wire, not through the client: a body that isn't an environment change is no change at all (and no "applied").
    const res = await fetch(`http://127.0.0.1:${host.info.port}/ptys/s6/restart`, {
      method: 'POST',
      headers: { 'x-work-token': host.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ agentEnv: { A: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('agentEnvApplied');
  });

  it('halt keeps the session and its terminals; resume starts it again in place; guards answer', async () => {
    await client.spawn('s7', { cwd: dir, tool: tool as never });
    const before = spawned.at(-1) as EchoPty;
    const a = attach('s7');
    await a.opened;
    expect(await client.halt('s7')).toBe('halted');
    expect(before.exited).toBe(true);
    expect(spawned.at(-1)).toBe(before); // nothing started yet
    expect(a.control.filter((f) => (f as { type: string }).type === 'exit')).toEqual([]);
    expect((await client.list()).find((p) => p.id === 's7')).toMatchObject({ clients: 1 });
    await expect(client.halt('s7')).rejects.toThrow(/already/); // a second halt is refused
    expect(await client.resume('s7', { agentEnv: { CLAUDE_CONFIG_DIR: '/acc/new' } })).toBe('resumed');
    const after = spawned.at(-1) as EchoPty;
    expect(after).not.toBe(before);
    a.ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await tick();
    expect(after.log).toContain('write hi');
    expect(await client.resume('s7')).toBe('not-halted');
    expect(await client.halt('nope')).toBe('not-running');
    a.ws.close();
  });

  it('refuses a spawn whose cwd does not exist', async () => {
    await expect(client.spawn('s3', { cwd: path.join(dir, 'nope'), tool: tool as never })).rejects.toThrow(/cwd/);
  });
});

describe('who answers a query (terminal-rendering.md): exactly one, decided as the output arrives', () => {
  beforeEach(() => {
    makePty = () => new MirrorPty();
  });
  afterEach(() => {
    makePty = () => new EchoPty();
  });
  const input = (c: { ws: WebSocket }, data: string) => c.ws.send(JSON.stringify({ type: 'input', data }));
  const ST = '\x1b\\';

  it('no client attached: the host answers what xterm answers, and colour queries with the tab’s colours — once', async () => {
    await client.spawn('q1', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    pty.print(`\x1b[c\x1b[?2026$p\x1b[6n\x1b[?6n\x1b]11;?${ST}\x1b]10;?;?\x07\x1b]4;1;?${ST}`);
    await tick();
    expect(pty.got).toEqual([
      '\x1b[?1;2c',
      '\x1b[?2026;2$y',
      '\x1b[1;1R',
      '\x1b[?1;1R',
      `\x1b]11;rgb:1e1e/1e1e/1e1e${ST}`,
      `\x1b]10;rgb:d4d4/d4d4/d4d4${ST}`,
      `\x1b]11;rgb:1e1e/1e1e/1e1e${ST}`,
      `\x1b]4;1;rgb:cccc/0000/0000${ST}`,
    ]);
    // A colour being set is not a query.
    pty.print(`\x1b]11;#ffffff${ST}`);
    await tick();
    expect(pty.got).toHaveLength(8);
  });

  it('clients attached: only the client used last answers (else the first attached), and the host stays silent', async () => {
    await client.spawn('q2', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    const a = attach('q2');
    await a.opened;
    const b = attach('q2');
    await b.opened;
    await tick();
    pty.print('\x1b[c');
    await tick();
    expect(a.binary.join('') + b.binary.join('')).toBe('\x1b[c\x1b[c'); // both were sent it…
    input(b, '\x1b[?62;22c');
    input(a, '\x1b[?1;2c');
    await tick();
    expect(pty.got).toEqual(['\x1b[?1;2c']); // …the first attached answered, alone; the host didn't
    b.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })); // b used now
    await tick();
    pty.print(`\x1b]11;?${ST}`);
    await tick();
    input(a, `\x1b]11;rgb:0000/0000/0000${ST}`);
    input(b, `\x1b]11;rgb:ffff/ffff/ffff${ST}`);
    await tick();
    expect(pty.got.slice(1)).toEqual([`\x1b]11;rgb:ffff/ffff/ffff${ST}`]);
    // Its colours are what the host answers with once nobody is attached.
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    await tick();
    pty.print(`\x1b]11;?${ST}`);
    await tick();
    expect(pty.got.slice(2)).toEqual([`\x1b]11;rgb:ffff/ffff/ffff${ST}`]);
  });

  it('typing makes a client the one that answers; reports from any client, and typing with replies in it, still go through', async () => {
    await client.spawn('q3', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    const a = attach('q3');
    await a.opened;
    const b = attach('q3');
    await b.opened;
    await tick();
    input(b, '\x1b[O\x1b[<35;3;3M'); // focus out, the mouse hovering: b not used, but sent on
    input(b, '\x1b[?1;2ck'); // an answer and a key in one frame: whole, never dropped — and b was used
    await tick();
    expect(pty.got).toEqual(['\x1b[O\x1b[<35;3;3M', '\x1b[?1;2ck']);
    pty.print('\x1b[5n');
    await tick();
    input(a, '\x1b[0n');
    input(b, '\x1b[3n');
    await tick();
    expect(pty.got.slice(2)).toEqual(['\x1b[3n']);
  });

  it('the client answering leaves before it did: the next attached answers what it was sent', async () => {
    await client.spawn('q4', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    const a = attach('q4');
    await a.opened;
    const b = attach('q4');
    await b.opened;
    await tick();
    pty.print('\x1b[c');
    await tick();
    a.ws.close();
    await a.closed;
    await tick();
    input(b, '\x1b[?62;22c');
    await tick();
    expect(pty.got).toEqual(['\x1b[?62;22c']);
    b.ws.close();
  });

  it('a query that arrived before a client attached (parsed after) is the host’s to answer, not the client’s', async () => {
    await client.spawn('q5', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    const sent: string[] = [];
    pty.print('\x1b[c');
    // Attached in the same turn: the screen's copy has not parsed the query yet.
    const late = host.registry.attach(
      'q5',
      (d) => sent.push(d),
      () => {},
    )!;
    await tick();
    expect(pty.got).toEqual(['\x1b[?1;2c']);
    expect((await late.ready).data).not.toContain('\x1b[c'); // its screen has no query in it…
    late.start();
    expect(sent).toEqual([]); // …nor was it sent one
    expect(late.replies(replyParts('\x1b[?62;22c')!)).toBe(''); // and an answer from it would not go through
    late.detach();
  });

  it('a client still drawing its screen answers the query held for it', async () => {
    await client.spawn('q6', { cwd: dir, tool: tool as never });
    const pty = spawned.at(-1) as MirrorPty;
    const sent: string[] = [];
    const drawing = host.registry.attach(
      'q6',
      (d) => sent.push(d),
      () => {},
    )!;
    pty.print('\x1b[5n'); // held until its screen is drawn
    await tick();
    expect(pty.got).toEqual([]); // the host leaves it to the client
    await drawing.ready;
    drawing.start();
    expect(sent).toEqual(['\x1b[5n']);
    expect(drawing.replies(replyParts('\x1b[0n')!)).toBe('\x1b[0n');
    drawing.detach();
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
