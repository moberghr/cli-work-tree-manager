import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { PtySession, onChildExit } from '../../../src/core/pty/pty-session.js';

/** A PTY paused for a slow client must not lose the agent's last output when the agent exits (flow control). */

describe('onChildExit', () => {
  /** node-pty 1.1.0's onexit, in short: the destroy timer, then `this.once('close')`. */
  class NodePtyLike {
    readonly onces: string[] = [];
    once(event: string) {
      this.onces.push(event);
    }
    onexit() {
      setTimeout(() => {}, 0);
      this.once('close');
    }
  }

  it("is called as node-pty starts waiting for its socket to close, and still lets node-pty's own wait through", () => {
    const pty = new NodePtyLike();
    const calls: string[] = [];
    expect(onChildExit(pty, () => calls.push('exiting'))).toBe(true);
    pty.once('data');
    expect(calls).toEqual([]);
    pty.onexit();
    expect(calls).toEqual(['exiting']);
    expect(pty.onces).toEqual(['data', 'close']);
  });

  it('nothing to hook: false', () => {
    expect(onChildExit({}, () => {})).toBe(false);
  });

  it("node-pty still marks its child's exit that way: the destroy timer, then this.once('close') (an upgrade that changes it fails here)", () => {
    const require = createRequire(import.meta.url);
    const lib = path.dirname(require.resolve('node-pty'));
    const unix = fs.readFileSync(path.join(lib, 'unixTerminal.js'), 'utf-8');
    const onexit = unix.slice(unix.indexOf('var onexit = function'), unix.indexOf('pty.fork('));
    expect(unix).toMatch(/DESTROY_SOCKET_TIMEOUT_MS = 200;/);
    expect(onexit).toMatch(/setTimeout\(function \(\) \{[\s\S]*_this\._socket\.destroy\(\);[\s\S]*\}, DESTROY_SOCKET_TIMEOUT_MS\);/);
    expect(onexit.indexOf("_this.once('close'")).toBeGreaterThan(onexit.indexOf('DESTROY_SOCKET_TIMEOUT_MS'));
    // Its only `once('close')` on itself: the others wait on its socket.
    expect(unix.match(/(?:this|_this|self)\.once\('close'/g)).toEqual(["_this.once('close'"]);
    const terminal = fs.readFileSync(path.join(lib, 'terminal.js'), 'utf-8');
    expect(terminal).toMatch(/Terminal\.prototype\.once = function/);
  });
});

describe.skipIf(process.platform === 'win32')('a PTY paused as its child exits (real PTY)', () => {
  let session: PtySession | undefined;
  let cwd: string;
  afterEach(() => {
    session?.dispose();
    session = undefined;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("loses none of its last output: read again once its child exits (Linux: past node-pty's 200 ms), or once released (macOS: the exit waits for it)", async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exit-'));
    // It proves the fix only on Linux, where node-pty drops what is unread 200 ms after the child exits: on macOS the
    // exit waits for the PTY to be released and read, so it passes there with or without the exit hook. Run everywhere
    // all the same (not skipped): there it still holds that a paused PTY loses nothing as its child exits.
    // Small enough to fit in the PTY's buffer: on Linux the child exits with it unread (a bigger write would block the
    // child until it is read). Without the exit hook, node-pty dropped all of it 200 ms later (measured on Linux).
    const script = `process.stdout.write('x'.repeat(2000) + 'END'); process.exit(0)`;
    session = new PtySession(cwd, 120, 30, { cmd: process.execPath, args: ['-e', script] });
    let got = '';
    session.setOutputHandler((d) => {
      got += d;
    });
    const exited = new Promise<number>((r) => (session!.onExit = r));
    session.pause!(); // before anything was read
    // Released long after node-pty's 200 ms (as the pacer's time-out would): on Linux the child exited meanwhile.
    setTimeout(() => session?.resume?.(), 600);
    expect(await exited).toBe(0);
    expect(got.endsWith('END')).toBe(true);
    expect(got.length).toBe(2003);
    // Once it is ending, nothing pauses it again.
    session.pause!();
    expect(session.exited).toBe(true);
  }, 10_000);
});
