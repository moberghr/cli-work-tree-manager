import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HALT_RESUME_MS, PtyRegistry, type PtyLike, type PtySpawner } from '../../../src/core/pty/pty-registry.js';
import type { AiToolSpec } from '../../../src/core/platform/ai-launcher.js';
import { isPersistedPty, keepEnv } from '../../../src/core/pty/pty-host-protocol.js';
import { withReporter } from '../../../src/core/platform/report.js';

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

  it('never restores the Ctrl+K assistant: it starts when opened (restored, one opened once ran for good)', async () => {
    const first = makeRegistry();
    first.spawn('a', { cwd: '/x', tool });
    first.spawn('assistant', { cwd: '/home/.work/assistant', tool });
    await first.flush();
    first.disposeAllKeepingState();
    await first.flush();
    const second = makeRegistry(() => true);
    expect(await second.restore()).toEqual(['a']);
    expect(second.get('assistant')).toBeNull();
    expect(Object.keys(readSaved())).toEqual(['a']); // and it's off the list from then on
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
    expect(asked).toHaveBeenCalledWith('/x', 'claude', expect.anything()); // and the environment it will start with
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

describe("a session's account (agentEnv)", () => {
  const reg = (hasConversation: (cwd: string, tool: string, env?: Readonly<Record<string, string | undefined>>) => boolean = () => false) =>
    new PtyRegistry({ spawner, hasConversation, sessionsPath, cwdExists: () => true, keepEnvNames: () => [] });
  const shell = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/other' };

  it('a named account sets CLAUDE_CONFIG_DIR over the launching shell’s, and a restore keeps it', async () => {
    const first = reg();
    first.spawn('a', { cwd: '/x', tool, env: shell, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
    expect(spawned[0].spec.env).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/acc/work' });
    await first.flush();
    expect(readSaved().a).toMatchObject({ keptEnv: { CLAUDE_CONFIG_DIR: '/acc/work' }, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
    first.disposeAllKeepingState();
    await reg().restore();
    expect(spawned[1].spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/acc/work' });
  });

  it('the default account takes an inherited CLAUDE_CONFIG_DIR out: from the shell, from the host, and from what is kept', async () => {
    const first = reg();
    first.spawn('a', { cwd: '/x', tool, env: shell, agentEnv: { CLAUDE_CONFIG_DIR: null } });
    expect(spawned[0].spec.env).toEqual({ PATH: '/bin' });
    await first.flush();
    expect(readSaved().a).not.toHaveProperty('keptEnv'); // nothing kept: no folder
    // No shell (the Terminal tab, a restore): the host's own environment, minus the folder.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/host-inherited');
    try {
      first.spawn('b', { cwd: '/y', tool, agentEnv: { CLAUDE_CONFIG_DIR: null } });
      expect(spawned[1].spec.env).toBeDefined();
      expect(spawned[1].spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(spawned[1].spec.env?.PATH ?? spawned[1].spec.env?.Path).toBeDefined();
      first.disposeAllKeepingState();
      await reg().restore();
      expect(spawned.at(-1)?.spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('without an account change a spawn keeps its env as before (none: the host’s own)', () => {
    reg().spawn('a', { cwd: '/x', tool });
    expect(spawned[0].spec.env).toBeUndefined();
    reg().spawn('b', { cwd: '/x', tool, env: shell, agentEnv: {} });
    expect(spawned[1].spec.env).toEqual(shell);
  });

  it('the resume check looks with the environment the agent will start with', async () => {
    const seen: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const r = reg((_cwd, _tool, env) => (seen.push(env), env?.CLAUDE_CONFIG_DIR === '/acc/work'));
    r.spawn('a', { cwd: '/x', tool, env: shell, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
    expect(spawned[0].spec.resume).toBe(true);
    r.spawn('b', { cwd: '/y', tool, env: shell, agentEnv: { CLAUDE_CONFIG_DIR: null } });
    expect(spawned[1].spec.resume).toBe(false);
    expect(seen[1]).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    // A restore after the host restarts: the entry's kept folder decides.
    await r.flush();
    r.disposeAllKeepingState();
    seen.length = 0;
    await reg((_c, _t, env) => (seen.push(env), env?.CLAUDE_CONFIG_DIR === '/acc/work')).restore();
    expect(spawned.filter((s) => s.spec.cwd === '/x').at(-1)?.spec.resume).toBe(true);
    expect(spawned.filter((s) => s.spec.cwd === '/y').at(-1)?.spec.resume).toBe(false);
  });

  it('a restart runs on the account too', async () => {
    const r = reg((_c, _t, env) => env?.CLAUDE_CONFIG_DIR === '/acc/work');
    r.spawn('a', { cwd: '/x', tool, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
    const before = spawned.length;
    const done = r.restart('a');
    spawned[before - 1].pty.exit(0);
    await done;
    expect(spawned[before].spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/acc/work' });
    expect(spawned[before].spec.resume).toBe(true);
  });

  it('a restart with a new agentEnv starts the process on it, and the restore list keeps it', async () => {
    const r = reg(() => true);
    const shell = { PATH: '/bin' };
    r.spawn('a', { cwd: '/x', tool, env: shell, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/old' } });
    expect(spawned[0].spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/acc/old' });
    const done = r.restart('a', undefined, { CLAUDE_CONFIG_DIR: '/acc/new' });
    spawned[0].pty.exit(0);
    await done;
    expect(spawned[1].spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/acc/new', PATH: '/bin' });
    await r.flush();
    expect(readSaved().a.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: '/acc/new' });
    expect(readSaved().a.keptEnv).toEqual({ CLAUDE_CONFIG_DIR: '/acc/new' });
    // To the default account: taken out of the environment and out of what a restore keeps.
    const back = r.restart('a', undefined, { CLAUDE_CONFIG_DIR: null });
    spawned[1].pty.exit(0);
    await back;
    expect(spawned[2].spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    await r.flush();
    expect(readSaved().a.keptEnv).toBeUndefined();
    expect(readSaved().a.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: null });
  });

  it('a restart that never stops the old process changes nothing about its environment', async () => {
    const r = reg(() => true);
    r.spawn('a', { cwd: '/x', tool, env: { PATH: '/bin' }, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/old' } });
    await expect(r.restart('a', 20, { CLAUDE_CONFIG_DIR: '/acc/new' })).rejects.toThrow(/didn't stop/);
    await r.flush();
    expect(Object.keys(readSaved())).toEqual([]); // ended as a stop is; nothing restored on the wrong account
  });

  it('keepEnv always keeps CLAUDE_CONFIG_DIR (a path, not a secret) — never one with a password in it', () => {
    expect(keepEnv({ CLAUDE_CONFIG_DIR: '/acc/work', OTHER: 'x' }, [])).toEqual({ CLAUDE_CONFIG_DIR: '/acc/work' });
    expect(keepEnv({ CLAUDE_CONFIG_DIR: '/acc/work', JAVA_HOME: '/jdk' }, ['JAVA_HOME'])).toEqual({
      JAVA_HOME: '/jdk',
      CLAUDE_CONFIG_DIR: '/acc/work',
    });
    expect(keepEnv({ CLAUDE_CONFIG_DIR: 'https://u:pw@h/x' }, [])).toBeUndefined();
    expect(keepEnv({ PATH: '/bin' }, [])).toBeUndefined();
  });

  it('a restore list entry with a malformed agentEnv is not respawned', () => {
    expect(isPersistedPty({ cwd: '/x', tool, startedAt: '', agentEnv: { CLAUDE_CONFIG_DIR: null } })).toBe(true);
    expect(isPersistedPty({ cwd: '/x', tool, startedAt: '', agentEnv: { A: 1 } })).toBe(false);
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

describe('halt / resume', () => {
  const spec = () => ({ cwd: dir, tool, keptEnv: { JAVA_HOME: '/jdk' }, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/old' } });
  /** Halt `s` (its process exits when asked to). */
  async function halted(reg: PtyRegistry) {
    const old = spawned.at(-1)!.pty;
    const halting = reg.halt('s');
    old.exit(0);
    await halting;
    return old;
  }

  it('stops the process but keeps the entry, its record and its clients, not told it ended', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    const exits: number[] = [];
    const a = reg.attach(
      's',
      () => {},
      (c) => exits.push(c),
    )!;
    a.start();
    const old = await halted(reg);
    expect(old.disposed).toBe(true);
    expect(exits).toEqual([]);
    expect(spawned).toHaveLength(1); // nothing started again
    expect(reg.get('s')).toMatchObject({ clients: 1 });
    await reg.flush();
    expect(Object.keys(readSaved())).toEqual(['s']); // still in the restore list
    // Attaching meanwhile joins it: not told it ended either.
    const late = reg.attach(
      's',
      () => {},
      () => exits.push(9),
    )!;
    expect(late.exitedWith).toBeNull();
    expect(exits).toEqual([]);
  });

  it('is not forgotten by the 5 s exit rule, and a spawn meanwhile starts no second agent', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    await halted(reg);
    await vi.advanceTimersByTimeAsync(10_000); // past the exit rule, before the auto-resume
    expect(reg.get('s')).not.toBeNull();
    reg.spawn('s', spec());
    expect(spawned).toHaveLength(1);
  });

  it('a second halt or a restart while halted is refused', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    await halted(reg);
    await expect(reg.halt('s')).rejects.toThrow(/already/);
    await expect(reg.restart('s')).rejects.toThrow(/halted/);
    expect(spawned).toHaveLength(1);
  });

  it('a second halt while the first is still stopping is refused too', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    const first = reg.halt('s');
    await expect(reg.halt('s')).rejects.toThrow(/already/);
    spawned[0].pty.exit(0);
    await first;
  });

  it('resume starts it again in place with --continue and the given environment; clients carry on and get its output', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    const out: string[] = [];
    const exits: number[] = [];
    const a = reg.attach(
      's',
      (d) => out.push(d),
      (c) => exits.push(c),
    )!;
    a.start();
    await halted(reg);
    const info = await reg.resume('s', { CLAUDE_CONFIG_DIR: '/acc/new' });
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spec).toMatchObject({
      resume: true,
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/acc/new', JAVA_HOME: '/jdk' }),
    });
    expect(info).toMatchObject({ exited: false, clients: 1 });
    spawned[1].pty.emit('hi');
    expect(out).toEqual(['hi']);
    expect(exits).toEqual([]);
    await reg.flush();
    expect(readSaved().s.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: '/acc/new' });
    // And it can be halted again now.
    const again = reg.halt('s');
    spawned[1].pty.exit(0);
    await again;
  });

  it('resume of one that is not halted is null (and starts nothing)', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    expect(await reg.resume('s')).toBeNull();
    expect(await reg.resume('nope')).toBeNull();
    expect(spawned).toHaveLength(1);
  });

  it('with no resume within the timeout it starts again on its OLD spec, so a work web that died leaves no dead session', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    await halted(reg);
    await vi.advanceTimersByTimeAsync(HALT_RESUME_MS - 1);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spec).toMatchObject({ resume: true });
    expect(spawned[1].spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/acc/old' });
    expect(reg.get('s')).toMatchObject({ exited: false });
    // The timer is spent: a late resume finds nothing halted.
    expect(await reg.resume('s')).toBeNull();
  });

  it('waits minutes, not seconds (a big move across volumes), and says so at warn when it starts it by itself', async () => {
    expect(HALT_RESUME_MS).toBe(5 * 60_000);
    // Real timers (a fake setTimeout loses the reporter's async scope), with a short wait for the test.
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    const warns: string[] = [];
    await withReporter(
      (level, text) => {
        if (level === 'warn') warns.push(text);
      },
      async () => {
        const old = spawned.at(-1)!.pty;
        const halting = reg.halt('s', 3000, 20);
        old.exit(0);
        await halting;
      },
    );
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(warns).toEqual([expect.stringMatching(/^s: halted, and no resume within 0 s: starting it again/)]);
  });

  it('a resume cancels the auto-resume; a kill while halted cancels it too', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    await halted(reg);
    await reg.resume('s');
    await vi.advanceTimersByTimeAsync(HALT_RESUME_MS * 2);
    expect(spawned).toHaveLength(2);
    const second = spawned[1].pty;
    const halting = reg.halt('s');
    second.exit(0);
    await halting;
    await reg.kill('s');
    await vi.advanceTimersByTimeAsync(HALT_RESUME_MS * 2);
    expect(spawned).toHaveLength(2);
    expect(reg.get('s')).toBeNull();
  });

  it('an agent that will not stop within the timeout ends the session (as a restart does) and the halt fails', async () => {
    const reg = makeRegistry(() => true);
    reg.spawn('s', spec());
    await expect(reg.halt('s', 20)).rejects.toThrow(/did not stop|didn.t stop/);
    expect(reg.get('s')).toBeNull();
  });

  it('halt of nothing running is null', async () => {
    const reg = makeRegistry();
    expect(await reg.halt('nope')).toBeNull();
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
