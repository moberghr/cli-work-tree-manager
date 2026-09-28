import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { PtyRegistry } from '../../src/core/pty-registry.js';
import { startPtyHost, type PtyHostHandle } from '../../src/core/pty-host.js';
import { PtyHostClient } from '../../src/core/pty-host-client.js';
import type { AiToolSpec } from '../../src/core/ai-launcher.js';

/**
 * Functional tests: the real PTY stack — node-pty/ConPTY, the headless
 * xterm mirror, screen serialization, the host's HTTP + WebSocket server —
 * with a tiny echo script standing in for Claude. Nothing is mocked except
 * which program runs, and all state lives in a temp dir.
 */

const ECHO_AI = path.resolve(__dirname, 'fixtures/echo-ai.cjs');
const tool = {
  cmd: 'node',
  baseArgs: [ECHO_AI],
  unsafeFlag: '',
  resumeFlag: '--continue',
  promptFileFlag: '',
  promptFlag: '',
} as unknown as AiToolSpec;

let dir: string;
let sessionsPath: string;
let cwd: string;
const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-func-'));
  sessionsPath = path.join(dir, 'pty-sessions.json');
  cwd = path.join(dir, 'worktree');
  fs.mkdirSync(cwd);
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function registry(hasConversation = () => false) {
  const reg = new PtyRegistry({ sessionsPath, hasConversation });
  // Kill (and wait for exit) rather than just dispose, so the temp cwd is
  // released before afterEach deletes it.
  cleanup.push(async () => {
    await Promise.all(reg.list().map((p) => reg.kill(p.id)));
  });
  return reg;
}

async function waitFor(pred: () => boolean, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Attach through the registry and collect output. */
function collect(reg: PtyRegistry, id: string) {
  const out = { text: '', exit: null as number | null };
  const att = reg.attach(id, (d) => { out.text += d; }, (c) => { out.exit = c; });
  cleanup.push(() => att?.detach());
  return { out, replay: att?.replay };
}

describe('PTY registry on a real ConPTY / pty', () => {
  it('runs the tool in the worktree and round-trips input and output', async () => {
    const reg = registry();
    reg.spawn('s', { cwd, tool });
    const { out } = collect(reg, 's');
    await waitFor(() => out.text.includes('fake-ai ready'), 15_000, 'banner');
    expect(out.text).toContain('args=[]'); // no conversation → no --continue
    reg.write('s', 'hello\r');
    await waitFor(() => out.text.includes('echo:hello'), 15_000, 'echo');
  });

  it('passes --continue when the directory has a prior conversation', async () => {
    const reg = registry(() => true);
    reg.spawn('s', { cwd, tool });
    const { out } = collect(reg, 's');
    await waitFor(() => out.text.includes('fake-ai ready'), 15_000, 'banner');
    expect(out.text).toContain('args=[--continue]');
  });

  it('replays a late attacher the serialized screen, not raw history', async () => {
    const reg = registry();
    reg.spawn('s', { cwd, tool, cols: 100, rows: 30 });
    const first = collect(reg, 's');
    await waitFor(() => first.out.text.includes('fake-ai ready'), 15_000, 'banner');
    reg.write('s', 'one\r');
    await waitFor(() => first.out.text.includes('echo:one'), 15_000, 'echo');
    // The headless mirror parses asynchronously; give it a beat.
    await new Promise((r) => setTimeout(r, 300));

    const late = collect(reg, 's');
    expect(late.replay).toMatchObject({ cols: 100, rows: 30 });
    const plain = late.replay!.data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    expect(plain).toContain('fake-ai ready');
    expect(plain).toContain('echo:one');
  });

  it('restores a session after the host goes away (crash / reboot)', async () => {
    const first = registry();
    const before = first.spawn('s', { cwd, tool });
    await first.flush();
    first.disposeAllKeepingState(); // host dies; PTY dies with it

    const second = registry(() => true);
    expect(await second.restore()).toEqual(['s']);
    const after = second.get('s')!;
    expect(after.restored).toBe(true);
    expect(after.pid).not.toBe(before.pid);
    const { out } = collect(second, 's');
    await waitFor(() => out.text.includes('fake-ai ready'), 15_000, 'restored banner');
    expect(out.text).toContain('args=[--continue]');
  });

  it('reports the exit of a tool that quits on its own and forgets it later', async () => {
    const quitter = { ...tool, baseArgs: ['-e', 'process.exit(7)'] } as AiToolSpec;
    const reg = registry();
    reg.spawn('s', { cwd, tool: quitter });
    const { out } = collect(reg, 's');
    await waitFor(() => out.exit !== null, 15_000, 'exit');
    expect(reg.get('s')?.exited).toBe(true);
  });
});

describe('PTY host server over real sockets', () => {
  let host: PtyHostHandle;
  let client: PtyHostClient;
  beforeEach(async () => {
    host = await startPtyHost({ registry: registry(), restore: false, writeInfo: false });
    client = new PtyHostClient(host.info);
    cleanup.push(() => host.stop());
    // Runs before stop() (cleanup is LIFO): kill and wait so the temp cwd
    // is released — stop() alone doesn't wait for exits.
    cleanup.push(async () => {
      await Promise.all(host.registry.list().map((p) => host.registry.kill(p.id)));
    });
  });

  function wsAttach(id: string) {
    const ws = new WebSocket(client.attachUrl(id));
    const s = { ws, text: '', control: [] as Array<Record<string, unknown>> };
    ws.on('message', (d, bin) => {
      if (bin) s.text += (d as Buffer).toString();
      else s.control.push(JSON.parse(d.toString()));
    });
    cleanup.push(() => ws.close());
    return s;
  }

  it('two clients share one session: both see output, either can type', async () => {
    await client.spawn('s', { cwd, tool });
    const a = wsAttach('s');
    const b = wsAttach('s');
    await waitFor(() => a.control.length > 0 && b.control.length > 0, 15_000, 'replay frames');
    expect(a.control[0].type).toBe('replay');

    a.ws.send(JSON.stringify({ type: 'input', data: 'from-a\r' }));
    await waitFor(() => b.text.includes('echo:from-a'), 15_000, 'b sees a');
    b.ws.send(JSON.stringify({ type: 'input', data: 'from-b\r' }));
    await waitFor(() => a.text.includes('echo:from-b'), 15_000, 'a sees b');
  });

  it('a client disconnecting leaves the session running', async () => {
    await client.spawn('s', { cwd, tool });
    const a = wsAttach('s');
    await waitFor(() => a.control.length > 0, 15_000, 'replay');
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const [info] = await client.list();
    expect(info.exited).toBe(false);
    expect(await client.write('s', 'still-here\r')).toBe(true);
    const b = wsAttach('s');
    await waitFor(() => b.text.includes('echo:still-here') ||
      String(b.control[0]?.data ?? '').includes('echo:still-here'), 15_000, 'reattach');
  });

  it('kill waits for the process to exit, so its worktree can be deleted right away', async () => {
    await client.spawn('s', { cwd, tool });
    await client.kill('s');
    // Worktree deletion follows a kill immediately (Delete session). On
    // Windows this fails with EBUSY/EPERM if the process still holds cwd.
    fs.rmSync(cwd, { recursive: true, force: true });
    expect(fs.existsSync(cwd)).toBe(false);
    expect(await client.list()).toEqual([]);
    await host.registry.flush();
    expect(JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))).toEqual({});
  });
});
