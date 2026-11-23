import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import xtermUnicode11 from '@xterm/addon-unicode11';
import { killTree, runAll } from './fixtures/processes.js';
import { PtyRegistry } from '../../src/core/pty/pty-registry.js';
import { startPtyHost, type PtyHostHandle } from '../../src/core/pty/pty-host.js';
import { PtyHostClient } from '../../src/core/pty/pty-host-client.js';
import { AckCounter, ackFrame, utf16Length, withFlow } from '../../src/core/pty/flow-control.js';
import { StreamPosition, withResume, type ResumePoint } from '../../src/core/pty/resume.js';
import { FRAME_HOLD_MS, realTimers, type PacerTimers } from '../../src/core/pty/output-pacer.js';
import type { AiToolSpec } from '../../src/core/platform/ai-launcher.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;
const { Unicode11Addon } = xtermUnicode11;

/**
 * Reattach where it left off, end to end (terminal-rendering.md, "Reattach where you left off"): a real PTY through the
 * real host, two clients drawing into real (headless) xterm.js terminals. One stays connected; the other's socket is
 * killed mid-stream — once at an arbitrary point, once inside a synchronized frame — and it reconnects with the offset
 * it counted. Every step waits on what was seen (the clients' output, the host's screen copy), never on time: what it
 * is sent must be exactly the stream from where it stood, and both screens (and scrollbacks), serialized, the same.
 */

/**
 * The host's clock, but with the cap on holding a synchronized frame (FRAME_HOLD_MS, a guard against an agent that
 * stalls mid-frame) never armed: the held frame is then held until its end however slow the machine is, so the cut is
 * inside it on every run — not only when the test got there within the cap. Every frame flood-ai.cjs starts, it ends.
 */
const NOT_ARMED = Symbol('frame cap not armed');
const timers: PacerTimers = {
  now: realTimers.now,
  set: (fn, ms) => (ms === FRAME_HOLD_MS ? NOT_ARMED : realTimers.set(fn, ms)),
  clear: (handle) => {
    if (handle !== NOT_ARMED) realTimers.clear(handle);
  },
};

const FLOOD_AI = path.resolve(__dirname, 'fixtures/flood-ai.cjs');
const tool = { cmd: 'node', baseArgs: [FLOOD_AI], resumeFlag: '--continue', promptFileFlag: '', promptFlag: '' } as unknown as AiToolSpec;
const BSU = '\x1b[?2026h';
/** The step whose synchronized frame the agent holds open until told (flood-ai.cjs), its two halves, and their marks. */
const HOLD_STEP = 150;
const FRAME_START = `${BSU}\x1b7\x1b[1;1H\x1b[2K\x1b[7m top ${HOLD_STEP} `;
const TOP = ` top ${HOLD_STEP} `;
const BOTTOM = ` bottom ${HOLD_STEP} `;

let dir: string;
let worktree: string;
const cleanup: Array<() => void | Promise<void>> = [];
const pids = new Set<number>();
let host: PtyHostHandle;
let client: PtyHostClient;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resume-'));
  worktree = path.join(dir, 'worktree');
  fs.mkdirSync(worktree);
  const registry = new PtyRegistry({ sessionsPath: path.join(dir, 'pty-sessions.json'), hasConversation: () => false, timers });
  host = await startPtyHost({ registry, restore: false, writeInfo: false });
  client = new PtyHostClient(host.info);
  cleanup.push(() => host.stop());
  // Runs before stop() (cleanup is LIFO): kill and wait, so the temp cwd is released.
  cleanup.push(async () => {
    for (const p of host.registry.list()) pids.add(p.pid);
    await Promise.all(host.registry.list().map((p) => host.registry.kill(p.id)));
  });
});
afterEach(async () => {
  try {
    await runAll(cleanup.splice(0).reverse());
  } finally {
    for (const pid of pids) killTree(pid);
    pids.clear();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Replay = { type: 'replay'; data: string; cols: number; rows: number; stream: string; offset: number; resumed?: true };

/** A client as the Terminal tab is: an xterm.js terminal it draws into, its position counted, acking what it drew. */
function viewer(cols: number, rows: number) {
  const term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  cleanup.push(() => term.dispose());
  const position = new StreamPosition();
  const v = {
    text: '',
    /** The output stream from its first screen on, as it was given it: live frames and what it missed, in order. */
    live: '',
    /** Each live frame, as sent. */
    frames: [] as string[],
    /** The offset its first screen stood at (where `live` starts). */
    start: 0,
    replays: [] as Replay[],
    ws: null as WebSocket | null,
    connect(id: string, at: ResumePoint | null) {
      const ws = new WebSocket(withResume(withFlow(client.attachUrl(id)), at));
      v.ws = ws;
      const acks = new AckCounter((chars) => ws.readyState === WebSocket.OPEN && ws.send(ackFrame(chars)));
      ws.on('message', (d, binary) => {
        if (v.ws !== ws) return;
        if (binary) {
          const bytes = new Uint8Array(d as Buffer);
          const chars = utf16Length(bytes);
          const text = Buffer.from(bytes).toString();
          position.output(chars);
          v.text += text;
          v.live += text;
          v.frames.push(text);
          term.write(bytes, () => acks.drawn(chars));
          return;
        }
        const msg = JSON.parse(d.toString()) as Replay;
        if (msg.type !== 'replay') return;
        if (!v.replays.length) v.start = msg.offset;
        else if (!msg.resumed) throw new Error(`a screen where a resume was expected (at ${msg.offset})`);
        else v.live += msg.data;
        v.replays.push(msg);
        position.replay(msg);
        v.text += msg.data;
        // What it missed, on the screen it kept; a screen, over a reset terminal (as PtyView draws them).
        term.write(msg.resumed ? msg.data : '\x1bc' + msg.data);
      });
      cleanup.push(() => ws.terminate());
      return new Promise<void>((r) => ws.on('open', () => r()));
    },
    /** Its connection gone at once (no close handshake), as a network drop or a killed relay is. */
    drop() {
      v.ws?.terminate();
      v.ws = null;
    },
    point: () => position.point(cols, rows)!,
    serialized: () => new Promise<string>((r) => term.write('', () => r(serializer.serialize()))),
  };
  return v;
}

describe('reattaching where it left off, on a real PTY through the host', () => {
  it('a client whose socket is killed mid-stream (once inside a synchronized frame) is sent exactly what it missed, and ends with the same screen', async () => {
    await client.spawn('s', { cwd: worktree, tool, cols: 80, rows: 24 });
    for (const p of host.registry.list()) pids.add(p.pid);
    const a = viewer(80, 24);
    const b = viewer(80, 24);
    await a.connect('s', null);
    await b.connect('s', null);
    await waitFor(() => a.text.includes('flood ready') && b.text.includes('flood ready'), 15_000, 'the agent');
    a.ws!.send(JSON.stringify({ type: 'input', data: 'go\r' }));

    // Cut 1: anywhere in the stream (before the held frame: the agent waits there). Reconnected once the other client
    // has at least 1 000 characters this one hasn't.
    await waitFor(() => b.text.length > 30_000, 15_000, 'output');
    const at1 = b.point();
    b.drop();
    await waitFor(() => a.point().offset >= at1.offset + 1000, 15_000, 'output it misses');
    await b.connect('s', at1);
    await waitFor(() => b.replays.length === 2, 15_000, 'the first resume');
    expect(b.replays[1]).toMatchObject({ resumed: true, stream: at1.stream });
    expect(b.replays[1].data.length).toBeGreaterThanOrEqual(1000);

    // Cut 2: inside a synchronized frame. Its first half is on the host's screen copy, so the host holds it (PtySession
    // hands each chunk to the copy and the pacer at once) and has sent none of it: this client, connected until then,
    // has seen nothing of it. It is cut there, and reconnects — the host attaches it as it accepts the socket, so
    // before `open` — before the frame's end is printed.
    fs.writeFileSync(path.join(worktree, 'hold-go'), '');
    await waitFor(async () => (await client.screen('s'))?.includes(TOP) === true, 15_000, 'the held frame');
    expect(b.text).not.toContain(TOP);
    expect(a.text).not.toContain(TOP);
    const at2 = b.point();
    b.drop();
    await b.connect('s', at2);
    fs.writeFileSync(path.join(worktree, 'hold-finish'), '');
    await waitFor(() => b.replays.length === 3, 15_000, 'the second resume');
    const missed = b.replays[2].data;
    expect(b.replays[2]).toMatchObject({ resumed: true, stream: at2.stream });

    await waitFor(() => a.text.includes('FLOOD-DONE') && b.text.includes('FLOOD-DONE'), 20_000, 'the end of the stream');
    // Nothing lost, nothing twice: from where its first screen stood, it was given exactly the other's stream.
    expect(b.start).toBeGreaterThanOrEqual(a.start);
    expect(b.live).toBe(a.live.slice(b.start - a.start));
    // The frame it was cut in: in what it missed, whole — the host waited for its end — as the other client was sent it,
    // in one piece.
    expect(missed).toContain(FRAME_START);
    expect(missed).toContain(BOTTOM);
    expect(a.frames.some((f) => f.includes(FRAME_START) && f.includes(BOTTOM))).toBe(true);

    const [screenA, screenB] = await Promise.all([a.serialized(), b.serialized()]);
    expect(screenB).toBe(screenA);
    expect(screenA).toContain('FLOOD-DONE');
  });
});
