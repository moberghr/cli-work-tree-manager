import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PtyRegistry, type PtyLike, type PtySpawner } from '../../../src/core/pty/pty-registry.js';
import type { AiToolSpec } from '../../../src/core/platform/ai-launcher.js';
import { isPersistedPty, keepEnv } from '../../../src/core/pty/pty-host-protocol.js';

const tool = { cmd: 'claude', baseArgs: [], unsafeFlag: '', resumeFlag: '--continue' } as unknown as AiToolSpec;

class FakePty implements PtyLike {
  static nextPid = 100;
  readonly pty = { pid: FakePty.nextPid++ };
  exited = false;
  disposed = false;
  onExit?: (code: number) => void;
  output?: (data: string) => void;
  written: string[] = [];
  size: [number, number] = [0, 0];
  setOutputHandler(h?: (data: string) => void) {
    this.output = h;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.size = [c, r];
  }
  dispose() {
    this.disposed = true;
  }
  emit(d: string) {
    this.output?.(d);
  }
  exit(code: number) {
    this.exited = true;
    this.onExit?.(code);
  }
}

let dir: string;
let sessionsPath: string;
let spawned: Array<{ spec: Parameters<PtySpawner>[0]; pty: FakePty }>;
const spawner: PtySpawner = (spec) => {
  const pty = new FakePty();
  spawned.push({ spec, pty });
  return pty;
};

function makeRegistry(hasConversation: (cwd: string) => boolean = () => false) {
  return new PtyRegistry({ spawner, hasConversation, sessionsPath, cwdExists: () => true });
}
const readSaved = () => JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-registry-'));
  sessionsPath = path.join(dir, 'pty-sessions.json');
  spawned = [];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PtyRegistry', () => {
  it('passes --continue only when the directory has a prior conversation', () => {
    const reg = makeRegistry((cwd) => cwd === '/has');
    reg.spawn('a', { cwd: '/has', tool });
    reg.spawn('b', { cwd: '/never', tool });
    expect(spawned.map((s) => s.spec.resume)).toEqual([true, false]);
  });

  it('is idempotent for a live PTY and respawns an exited one', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    reg.spawn('a', { cwd: '/x', tool });
    expect(spawned).toHaveLength(1);
    spawned[0].pty.exit(0);
    reg.spawn('a', { cwd: '/x', tool });
    expect(spawned).toHaveLength(2);
  });

  it('replays earlier output to a late attacher and streams new output', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    spawned[0].pty.emit('hello ');
    const got: string[] = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
    );
    expect(att?.replay.data).toBe('hello ');
    spawned[0].pty.emit('world');
    expect(got).toEqual(['world']);
    att?.detach();
    spawned[0].pty.emit('!');
    expect(got).toEqual(['world']);
  });

  it('reports how many clients are attached and when it last printed (for putting idle ones to sleep)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    expect(reg.get('a')).toMatchObject({ clients: 0, lastOutputAt: '2026-09-30T10:00:00.000Z' });
    const one = reg.attach(
      'a',
      () => {},
      () => {},
    );
    const two = reg.attach(
      'a',
      () => {},
      () => {},
    );
    expect(reg.get('a')?.clients).toBe(2);
    vi.setSystemTime(new Date('2026-09-30T12:30:00Z'));
    spawned[0].pty.emit('spinner frame');
    expect(reg.get('a')?.lastOutputAt).toBe('2026-09-30T12:30:00.000Z');
    one?.detach();
    two?.detach();
    expect(reg.get('a')?.clients).toBe(0);
  });

  it('persists live sessions and restores them on the next start', async () => {
    const first = makeRegistry();
    first.spawn('a', { cwd: '/x', tool, port: 4000 });
    await first.flush();
    expect(readSaved().a).toMatchObject({ cwd: '/x', port: 4000 });

    // Host dies (crash / reboot): shutdown keeps the persisted list.
    first.disposeAllKeepingState();
    await first.flush();

    const second = makeRegistry(() => true);
    const restored = await second.restore();
    expect(restored).toEqual(['a']);
    expect(second.get('a')?.restored).toBe(true);
    expect(spawned[1].spec).toMatchObject({ cwd: '/x', port: 4000, resume: true });
  });

  it('does not restore sessions whose worktree is gone', async () => {
    fs.writeFileSync(sessionsPath, JSON.stringify({ a: { cwd: '/gone', tool, startedAt: '' } }));
    const reg = new PtyRegistry({ spawner, hasConversation: () => false, sessionsPath, cwdExists: () => false });
    expect(await reg.restore()).toEqual([]);
    expect(readSaved()).toEqual({});
  });

  it('forgets an explicitly killed session', async () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    const killed = reg.kill('a');
    spawned[0].pty.exit(0); // the fake exits when killed
    await killed;
    await reg.flush();
    expect(spawned[0].pty.disposed).toBe(true);
    expect(readSaved()).toEqual({});
  });

  it('a kill tells the attached terminals it ended, so they offer to start it again (reported: a tab that took no input)', async () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    const onExit = vi.fn();
    const output = vi.fn();
    reg.attach('a', output, onExit)!.start();
    const killed = reg.kill('a');
    spawned[0].pty.emit('late'); // nothing more reaches it once it's being killed
    spawned[0].pty.exit(1);
    await killed;
    expect(onExit).toHaveBeenCalledWith(1);
    expect(output).not.toHaveBeenCalledWith('late');
    // A process that doesn't exit in time: still told, when the wait ends.
    reg.spawn('b', { cwd: '/x', tool });
    const onExitB = vi.fn();
    reg.attach('b', () => {}, onExitB);
    await reg.kill('b', 10);
    expect(onExitB).toHaveBeenCalledWith(0);
  });

  it('keeps a self-exited session persisted briefly (shutdown race), then forgets it', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    spawned[0].pty.exit(0);
    await reg.flush();
    expect(readSaved().a).toBeDefined();
    vi.advanceTimersByTime(6000);
    vi.useRealTimers();
    await reg.flush();
    expect(readSaved()).toEqual({});
  });

  it('ignores no-op resizes', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, cols: 80, rows: 24 });
    reg.resize('a', 80, 24);
    expect(spawned[0].pty.size).toEqual([0, 0]);
    reg.resize('a', 100, 30);
    expect(spawned[0].pty.size).toEqual([100, 30]);
  });
});

describe('PtyRegistry replay', () => {
  it('prefers the serialized screen over raw history when the PTY supports it', () => {
    const serializing: PtySpawner = () => {
      const p = new FakePty() as FakePty & { serialize: () => string };
      p.serialize = () => '<screen>';
      return p;
    };
    const reg = new PtyRegistry({ spawner: serializing, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool, cols: 90, rows: 20 });
    expect(
      reg.attach(
        'a',
        () => {},
        () => {},
      )?.replay,
    ).toEqual({ data: '<screen>', cols: 90, rows: 20 });
  });
});

describe('PtyRegistry launch options', () => {
  it('--fresh skips --continue even when a conversation exists', () => {
    const reg = makeRegistry(() => true);
    reg.spawn('a', { cwd: '/x', tool, fresh: true });
    expect(spawned[0].spec.resume).toBe(false);
  });

  it('passes unsafe, the prompt and the forwarded env to the first spawn', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, unsafe: true, initialPrompt: 'do it', env: { A: '1' } });
    expect(spawned[0].spec).toMatchObject({ unsafe: true, initialPrompt: 'do it', env: { A: '1' } });
  });

  it('never persists env, prompt or fresh; a restore keeps unsafe and continues', async () => {
    const first = makeRegistry();
    first.spawn('a', { cwd: '/x', tool, unsafe: true, fresh: true, initialPrompt: 'p', env: { SECRET: 's' } });
    await first.flush();
    const saved = readSaved().a;
    expect(saved).toMatchObject({ cwd: '/x', unsafe: true });
    expect(saved).not.toHaveProperty('env');
    expect(saved).not.toHaveProperty('initialPrompt');
    expect(saved).not.toHaveProperty('fresh');
    expect(fs.readFileSync(sessionsPath, 'utf-8')).not.toContain('SECRET');

    first.disposeAllKeepingState();
    const second = makeRegistry(() => true);
    await second.restore();
    expect(spawned[1].spec).toMatchObject({ unsafe: true, resume: true });
    expect(spawned[1].spec.initialPrompt).toBeUndefined();
    expect(spawned[1].spec.env).toBeUndefined();
  });
});

describe('resume is the agent’s call, by the tool it was spawned with', () => {
  it('asks with the folder and the tool; an agent work has no adapter for never resumes', () => {
    const asked = vi.fn((_cwd: string, _tool: string) => true);
    const reg = new PtyRegistry({ spawner, hasConversation: asked, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool });
    expect(asked).toHaveBeenCalledWith('/x', 'claude');
    expect(spawned[0].spec.resume).toBe(true);

    // The default check: opencode has no adapter, so no --continue, whatever is on disk.
    const plain = new PtyRegistry({ spawner, sessionsPath, cwdExists: () => true });
    plain.spawn('b', { cwd: '/y', tool: { ...tool, cmd: 'opencode' } });
    expect(spawned[1].spec.resume).toBe(false);
  });
});

describe('variables a restore keeps (config hostEnv)', () => {
  const withNames = (names: string[], hasConversation: () => boolean = () => false) =>
    new PtyRegistry({ spawner, hasConversation, sessionsPath, cwdExists: () => true, keepEnvNames: () => names });

  it('keeps the named ones from the launching shell — never secret-looking ones — and a restore puts them back', async () => {
    const first = withNames(['JAVA_HOME', 'GITHUB_TOKEN', 'API_KEY', 'MISSING']);
    first.spawn('a', { cwd: '/x', tool, env: { JAVA_HOME: '/jdk21', GITHUB_TOKEN: 't', API_KEY: 'k', OTHER: 'o' } });
    await first.flush();
    expect(readSaved().a.keptEnv).toEqual({ JAVA_HOME: '/jdk21' });
    expect(fs.readFileSync(sessionsPath, 'utf-8')).not.toMatch(/"t"|"k"|OTHER/);

    first.disposeAllKeepingState();
    const second = withNames([], () => true);
    await second.restore();
    expect(spawned[1].spec.env).toMatchObject({ JAVA_HOME: '/jdk21' });
    expect(spawned[1].spec.env?.PATH ?? spawned[1].spec.env?.Path).toBeDefined(); // over the host's own
    await second.flush();
    expect(readSaved().a.keptEnv).toEqual({ JAVA_HOME: '/jdk21' }); // still kept for the next one
  });

  it('lists each PTY with its tool (for a status from output when it has no hooks)', () => {
    const reg = withNames([]);
    reg.spawn('a', { cwd: '/x', tool });
    expect(reg.get('a')?.tool).toBe('claude');
  });

  it('a respawn without a shell (the Terminal tab) runs with what was kept', () => {
    const reg = withNames(['JAVA_HOME']);
    reg.spawn('a', { cwd: '/x', tool, env: { JAVA_HOME: '/jdk21' } });
    spawned[0].pty.exit(0);
    reg.spawn('a', { cwd: '/x', tool });
    expect(spawned[1].spec.env).toMatchObject({ JAVA_HOME: '/jdk21' });
  });

  it('nothing named, nothing kept: the env stays one-shot', async () => {
    const reg = withNames([]);
    reg.spawn('a', { cwd: '/x', tool, env: { JAVA_HOME: '/jdk21' } });
    await reg.flush();
    expect(readSaved().a).not.toHaveProperty('keptEnv');
  });

  it('a restore list entry with a malformed keptEnv is not respawned', () => {
    expect(isPersistedPty({ cwd: '/x', tool, startedAt: '', keptEnv: { A: 1 } })).toBe(false);
    expect(isPersistedPty({ cwd: '/x', tool, startedAt: '', keptEnv: { A: '1' } })).toBe(true);
    expect(keepEnv(undefined, ['A'])).toBeUndefined();
  });

  it('secret-looking names and values are never kept (reviewed gaps)', () => {
    const env = {
      DB_PASS: 'p',
      DATABASE_URL: 'x',
      CONNECTION_STRING: 'x',
      GH_PAT: 'x',
      NPM_AUTH: 'x',
      SENTRY_DSN: 'x',
      SSH_KEY_PATH: 'x',
      MY_HOST: 'https://u:pw@h/db',
      JAVA_HOME: '/jdk',
      PATH: '/bin',
      GOPATH: '/go',
    };
    expect(keepEnv(env, Object.keys(env))).toEqual({ JAVA_HOME: '/jdk', PATH: '/bin', GOPATH: '/go' });
  });
});

describe('attaching to a PTY that already exited (reviewed bug)', () => {
  it('reports the exit right away instead of a silent dead screen', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    spawned[0].pty.emit('bye');
    spawned[0].pty.exit(3);
    const onExit = vi.fn();
    const att = reg.attach('a', () => {}, onExit);
    expect(att?.exitedWith).toBe(3);
    expect(att?.replay.data).toBe('bye');
    // Not subscribed: nothing further will ever be delivered.
    spawned[0].pty.emit('late');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('a live PTY reports exitedWith null and gets the exit later', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    const onExit = vi.fn();
    const att = reg.attach('a', () => {}, onExit);
    expect(att?.exitedWith).toBeNull();
    spawned[0].pty.exit(0);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe('attaching while the screen is still parsing (a late attacher must not lose output)', () => {
  /** A PTY whose screen parses later, as xterm's does: serializeSettled resolves when told. */
  class ParsingPty extends FakePty {
    screen = 'before';
    settle: (screen: string) => void = () => {};
    serialize() {
      return this.screen;
    }
    serializeSettled() {
      return new Promise<string>((r) => (this.settle = r));
    }
  }

  it('the snapshot is the screen as of the attach; output after it is held, then handed over once, in order', async () => {
    const pty = new ParsingPty();
    const reg = new PtyRegistry({ spawner: () => pty, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool });
    const got: string[] = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
    )!;
    // Arrives after the attach, while the snapshot is being taken: not sent yet (the snapshot goes first).
    pty.emit('after-1');
    expect(got).toEqual([]);
    // The screen has parsed what came before the attach — including output a plain
    // serialize() would have missed.
    pty.settle('before + just-arrived');
    expect((await att.ready).data).toBe('before + just-arrived');
    expect(got).toEqual([]);
    att.start();
    pty.emit('after-2');
    expect(got).toEqual(['after-1', 'after-2']);
  });

  it('a screen with no parsing step streams at once, its replay the raw buffer', async () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    spawned[0].pty.emit('hello ');
    const got: string[] = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
    )!;
    expect((await att.ready).data).toBe('hello ');
    spawned[0].pty.emit('world');
    expect(got).toEqual(['world']);
  });
});

describe('restart', () => {
  const spec = () => ({ cwd: dir, tool, keptEnv: { JAVA_HOME: '/jdk' } });

  it('the new process goes into the same entry: clients get its output, a detach after it still detaches', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    const old = spawned[0].pty;
    const out: string[] = [];
    const exits: number[] = [];
    const a = reg.attach(
      's',
      (d) => out.push(d),
      (c) => exits.push(c),
    )!;
    a.start();
    const restarting = reg.restart('s');
    old.exit(0); // the old one stops
    const info = await restarting;
    const fresh = spawned[1];
    expect(fresh.spec).toMatchObject({ resume: true, env: expect.objectContaining({ JAVA_HOME: '/jdk' }) });
    expect(info).toMatchObject({ exited: false, clients: 1, pid: fresh.pty.pty.pid });
    fresh.pty.emit('hello');
    expect(out).toEqual(['hello']);
    expect(exits).toEqual([]); // the old one's end isn't the session's
    a.detach();
    expect(reg.get('s')?.clients).toBe(0);
    expect(Object.keys(readSaved())).toEqual(['s']);
  });

  it('a client attaching while it restarts joins it (not told it ended), and a spawn meanwhile starts no second one', async () => {
    const reg = makeRegistry();
    reg.spawn('s', spec());
    const old = spawned[0].pty;
    const restarting = reg.restart('s');
    old.exited = true; // exited, the new one not started yet
    const out: string[] = [];
    const b = reg.attach(
      's',
      (d) => out.push(d),
      () => {},
    )!;
    expect(b.exitedWith).toBeNull();
    b.start();
    reg.spawn('s', spec());
    expect(spawned).toHaveLength(1);
    old.onExit?.(0);
    await restarting;
    spawned[1].pty.emit('new');
    expect(out).toEqual(['new']);
    expect(spawned).toHaveLength(2);
  });

  it('an old one that does not stop in time: the session is ended as a stop is (terminals told), no second agent', async () => {
    const reg = makeRegistry();
    reg.spawn('s', spec());
    const exits: number[] = [];
    reg
      .attach(
        's',
        () => {},
        (c) => exits.push(c),
      )!
      .start();
    await expect(reg.restart('s', 20)).rejects.toThrow(/didn't stop.*stopped/);
    expect(spawned).toHaveLength(1);
    expect(exits).toEqual([1]);
    expect(reg.get('s')).toBeNull();
    expect(readSaved()).toEqual({});
  });

  it('a new one that cannot start ends the session as a kill does: its terminals are told', async () => {
    let fail = false;
    const reg = new PtyRegistry({
      spawner: (s) => {
        if (fail) throw new Error('spawn claude ENOENT');
        return spawner(s);
      },
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
    });
    reg.spawn('s', spec());
    const exits: number[] = [];
    reg
      .attach(
        's',
        () => {},
        (c) => exits.push(c),
      )!
      .start();
    fail = true;
    const restarting = reg.restart('s');
    spawned[0].pty.exit(0);
    await expect(restarting).rejects.toThrow(/ENOENT/);
    expect(exits).toEqual([1]);
    expect(reg.get('s')).toBeNull();
    expect(readSaved()).toEqual({});
  });

  it('asked twice, both get the one restart; it runs with the environment the session started with', async () => {
    const reg = makeRegistry();
    reg.spawn('s', { cwd: dir, tool, env: { PATH: '/nvm/bin', AWS_PROFILE: 'dev' } });
    const first = reg.restart('s');
    const second = reg.restart('s');
    spawned[0].pty.exit(0);
    const [a, b] = await Promise.all([first, second]);
    expect(spawned).toHaveLength(2);
    expect(a).toEqual(b);
    expect(spawned[1].spec.env).toMatchObject({ PATH: '/nvm/bin', AWS_PROFILE: 'dev' });
    // Never written to the restore list (it can hold secrets).
    expect(JSON.stringify(readSaved())).not.toContain('AWS_PROFILE');
  });

  it('a second restart while the first fails gets that failure, not "restarted"', async () => {
    const reg = makeRegistry();
    reg.spawn('s', spec());
    const first = reg.restart('s', 20);
    const second = reg.restart('s', 20);
    await expect(first).rejects.toThrow(/didn't stop/);
    await expect(second).rejects.toThrow(/didn't stop/);
  });

  it('a client attaching mid-restart does not wait on the old screen (disposed: its settle may never come)', async () => {
    const reg = new PtyRegistry({
      spawner: (spec) => {
        const p = spawner(spec) as FakePty & { serializeSettled?: () => Promise<string>; serialize?: () => string };
        p.serialize = () => 'old screen';
        p.serializeSettled = () => new Promise<string>(() => {}); // a disposed screen never answers
        return p;
      },
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
    });
    reg.spawn('s', spec());
    const restarting = reg.restart('s');
    const out: string[] = [];
    const a = reg.attach(
      's',
      (d) => out.push(d),
      () => {},
    )!;
    expect(a.replay.data).toBe('');
    const ready = await Promise.race([a.ready, new Promise((r) => setTimeout(() => r('stuck'), 50))]);
    expect(ready).not.toBe('stuck');
    a.start();
    spawned[0].pty.exit(0);
    await restarting;
    spawned[1].pty.emit('fresh');
    expect(out).toEqual(['fresh']);
  });
});
