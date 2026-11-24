import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_GRID,
  HALT_RESUME_MS,
  PtyRegistry,
  type AttachOptions,
  REDRAW_JIGGLE_MS,
  type ReplaySnapshot,
  type PtyLike,
  type PtySpawner,
} from '../../../src/core/pty/pty-registry.js';
import { CATCH_UP_MIN_MS, COALESCE_MS, FRAME_HOLD_MS } from '../../../src/core/pty/output-pacer.js';
import { RESUME_TAIL_CHARS } from '../../../src/core/pty/output-tail.js';
import { BSU, ESU } from '../../../src/core/pty/sync-output.js';
import type { StreamSignal } from '../../../src/core/pty/stream-status.js';
import { buildAiLaunchArgs, getAiTool, type AiToolSpec } from '../../../src/core/platform/ai-launcher.js';
import { isPersistedPty, keepEnv } from '../../../src/core/pty/pty-host-protocol.js';
import { withReporter } from '../../../src/core/platform/report.js';

const tool = { cmd: 'claude', baseArgs: [], resumeFlag: '--continue' } as unknown as AiToolSpec;

class FakePty implements PtyLike {
  static nextPid = 100;
  readonly pty = { pid: FakePty.nextPid++ };
  exited = false;
  disposed = false;
  onExit?: (code: number) => void;
  output?: (data: string) => void;
  written: string[] = [];
  size: [number, number] = [0, 0];
  /** Every resize, in order. */
  sizes: Array<[number, number]> = [];
  setOutputHandler(h?: (data: string) => void) {
    this.output = h;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.size = [c, r];
    this.sizes.push([c, r]);
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
    vi.useFakeTimers();
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
    // Within COALESCE_MS of 'hello ': it goes with what follows, once the window closes (output-pacer.ts).
    expect(got).toEqual([]);
    vi.advanceTimersByTime(COALESCE_MS);
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

  it('reports what its agent says about itself in its output (stream-status.ts): none, then its signal, none once it exited', () => {
    let said: StreamSignal | null = null;
    const reg = new PtyRegistry({
      spawner: (spec) => {
        const pty = Object.assign(new FakePty(), { streamSignal: () => said });
        spawned.push({ spec, pty });
        return pty;
      },
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
    });
    reg.spawn('a', { cwd: '/x', tool: { ...tool, cmd: 'codex' } });
    expect(reg.get('a')).not.toHaveProperty('signal');
    said = { program: { id: '', state: 'blocked', kind: 'permission', app: 'codex', since: '2026-11-23T10:00:00.000Z' } };
    expect(reg.get('a')?.signal).toEqual(said);
    spawned[0].pty.exited = true;
    expect(reg.get('a')).not.toHaveProperty('signal');
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

  it("never restores an account's login terminal, and a fresh one never resumes a conversation (the Accounts page's)", async () => {
    const first = makeRegistry(() => true);
    first.spawn('a', { cwd: '/x', tool });
    first.spawn('account-login:work', {
      cwd: '/home/.work/account-login',
      tool,
      fresh: true,
      agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' },
    });
    expect(spawned[1].spec.resume).toBe(false); // `fresh`: a login, not a conversation to go on with
    await first.flush();
    first.disposeAllKeepingState();
    await first.flush();
    const second = makeRegistry(() => true);
    expect(await second.restore()).toEqual(['a']);
    expect(second.get('account-login:work')).toBeNull();
    expect(Object.keys(readSaved())).toEqual(['a']);
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
    ).toEqual({ data: '<screen>', cols: 90, rows: 20, stream: expect.any(String), offset: expect.any(Number) });
  });
});

describe('PtyRegistry launch options', () => {
  it('--fresh skips --continue even when a conversation exists', () => {
    const reg = makeRegistry(() => true);
    reg.spawn('a', { cwd: '/x', tool, fresh: true });
    expect(spawned[0].spec.resume).toBe(false);
  });

  it('passes the prompt and the forwarded env to the first spawn', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, initialPrompt: 'do it', env: { A: '1' } });
    expect(spawned[0].spec).toMatchObject({ initialPrompt: 'do it', env: { A: '1' } });
  });

  it('an older client asking for unsafe: nothing of it is kept, and the agent starts in its own permission mode', async () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, ...{ unsafe: true } }); // an older `work` still sends it
    await reg.flush();
    expect(readSaved().a).not.toHaveProperty('unsafe');
    expect(buildAiLaunchArgs(getAiTool({}), spawned[0].spec).args).not.toContain('--dangerously-skip-permissions');
  });

  it("a restore list from an older host (unsafe: true, its tool's unsafeFlag) starts the agent without the flag", async () => {
    const oldTool = { ...getAiTool({}), unsafeFlag: '--dangerously-skip-permissions' };
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({ a: { cwd: '/x', tool: oldTool, unsafe: true, startedAt: '2026-10-01T09:00:00.000Z' } }),
    );
    const reg = makeRegistry(() => true);
    await reg.restore();
    expect(spawned).toHaveLength(1);
    const { args } = buildAiLaunchArgs(spawned[0].spec.tool, spawned[0].spec);
    // Started normally: work's own hooks file (`--settings`, given to every session's Claude) and its resume flag.
    expect(args).toEqual(['--settings', path.join(os.homedir(), '.work', 'claude-settings.json'), '--continue']);
    // The entry it rewrites says it starts normally: what lifts the one-release guards (legacy-unsafe.ts).
    expect(readSaved().a).not.toHaveProperty('unsafe');
    expect(readSaved().a.tool).not.toHaveProperty('unsafeFlag');
    // And a restart by this host keeps it so.
    const done = reg.restart('a');
    spawned[0].pty.exit(0);
    await done;
    await reg.flush();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spec).not.toHaveProperty('unsafe');
    expect(readSaved().a).not.toHaveProperty('unsafe');
    expect(readSaved().a.tool).not.toHaveProperty('unsafeFlag');
    // The restart carries work's hooks too, once (the flag is the host's, never doubled).
    expect(buildAiLaunchArgs(spawned[1].spec.tool, spawned[1].spec).args.filter((a) => a === '--settings')).toHaveLength(1);
  });

  it('never persists env, prompt or fresh; a restore continues', async () => {
    const first = makeRegistry();
    first.spawn('a', { cwd: '/x', tool, fresh: true, initialPrompt: 'p', env: { SECRET: 's' } });
    await first.flush();
    const saved = readSaved().a;
    expect(saved).toMatchObject({ cwd: '/x' });
    expect(saved).not.toHaveProperty('env');
    expect(saved).not.toHaveProperty('initialPrompt');
    expect(saved).not.toHaveProperty('fresh');
    expect(fs.readFileSync(sessionsPath, 'utf-8')).not.toContain('SECRET');

    first.disposeAllKeepingState();
    const second = makeRegistry(() => true);
    await second.restore();
    expect(spawned[1].spec).toMatchObject({ resume: true });
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
    vi.useFakeTimers();
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
    vi.advanceTimersByTime(COALESCE_MS); // coalesced with nothing else: sent as the window closes
    expect(got).toEqual(['after-1', 'after-2']);
  });

  it('a screen with no parsing step streams at once, its replay the raw buffer', async () => {
    vi.useFakeTimers();
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
    vi.advanceTimersByTime(COALESCE_MS);
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

describe('attaching at a size (terminal-rendering.md, "Resizing and attaching at a size")', () => {
  /** A PTY whose screen copy parses later, as xterm's does, and says which grid each snapshot was taken at. */
  class SizedPty extends FakePty {
    readonly log: string[] = [];
    settle: () => void = () => {};
    override resize(c: number, r: number) {
      super.resize(c, r);
      this.log.push(`resize ${c}x${r}`);
    }
    serialize() {
      this.log.push('serialize');
      return `screen@${this.size.join('x')}`;
    }
    serializeSettled() {
      this.log.push('serializeSettled');
      const at = this.size.join('x');
      return new Promise<string>((r) => (this.settle = () => r(`screen@${at}`)));
    }
  }
  const sized = () => {
    const pty = new SizedPty();
    const reg = new PtyRegistry({ spawner: () => pty, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    return { pty, reg };
  };

  it('a client stating its grid has the PTY (and its screen copy) resized BEFORE the snapshot, which is at that grid', async () => {
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 120, rows: 32 });
    const att = reg.attach(
      'a',
      () => {},
      () => {},
      { grid: { cols: 100, rows: 30 } },
    )!;
    expect(pty.log).toEqual(['resize 100x30', 'serialize', 'serializeSettled']);
    expect(att.replay).toMatchObject({ cols: 100, rows: 30 });
    pty.settle();
    expect(await att.ready).toEqual({ data: 'screen@100x30', cols: 100, rows: 30, stream: expect.any(String), offset: 0 });
    expect(reg.get('a')).toMatchObject({ cols: 100, rows: 30 });
  });

  it('a client stating none (a hidden tab, an older client) changes nothing: the snapshot is at the PTY grid', async () => {
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 120, rows: 32 });
    const att = reg.attach(
      'a',
      () => {},
      () => {},
    )!;
    expect(pty.log).toEqual(['serialize', 'serializeSettled']);
    pty.settle();
    expect(await att.ready).toEqual({ data: 'screen@0x0', cols: 120, rows: 32, stream: expect.any(String), offset: 0 }); // never resized: the grid it started at
  });

  it('a grid that is not one (too small, too big, not whole) is ignored', () => {
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 120, rows: 32 });
    for (const grid of [
      { cols: 2, rows: 1 },
      { cols: 5000, rows: 30 },
      { cols: 80.5, rows: 24 },
    ])
      reg.attach(
        'a',
        () => {},
        () => {},
        { grid },
      );
    expect(pty.sizes).toEqual([]);
    expect(reg.get('a')).toMatchObject({ cols: 120, rows: 32 });
  });

  it('the same grid as the PTY: no resize, so no repaint', () => {
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 100, rows: 30 });
    reg.attach(
      'a',
      () => {},
      () => {},
      { grid: { cols: 100, rows: 30 } },
    );
    expect(pty.sizes).toEqual([]);
  });

  it('nothing lost or doubled: the agent repaint for the new grid arrives after the snapshot and is handed over once', async () => {
    vi.useFakeTimers();
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 120, rows: 32 });
    pty.emit('before');
    const got: string[] = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
      { grid: { cols: 90, rows: 25 } },
    )!;
    pty.emit('repaint@90x25'); // its SIGWINCH answer: after the attach, held while the snapshot is taken
    expect(got).toEqual([]);
    pty.settle();
    expect((await att.ready).data).toBe('screen@90x25');
    att.start();
    pty.emit('live');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got.join('')).toBe('repaint@90x25live');
    expect(got.join('')).not.toContain('before'); // that is in the snapshot
  });

  it('a later client stating its grid takes the size from an earlier one (the one used last), and other clients go on', () => {
    const { pty, reg } = sized();
    reg.spawn('a', { cwd: '/x', tool, cols: 120, rows: 32 });
    reg.attach(
      'a',
      () => {},
      () => {},
      { grid: { cols: 100, rows: 30 } },
    );
    reg.attach(
      'a',
      () => {},
      () => {},
      { grid: { cols: 200, rows: 50 } },
    );
    reg.attach(
      'a',
      () => {},
      () => {},
    ); // hidden: states none
    expect(pty.sizes).toEqual([
      [100, 30],
      [200, 50],
    ]);
  });
});

describe('the grid an agent starts at', () => {
  it('a start that states one (the tab it is started for, `work attach`) starts at it', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, cols: 140, rows: 40 });
    expect(spawned[0].spec).toMatchObject({ cols: 140, rows: 40 });
  });

  it('a start with none takes the last grid a client set in this host, else the default', () => {
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    expect(spawned[0].spec).toMatchObject(DEFAULT_GRID);
    reg.resize('a', 100, 28);
    reg.spawn('b', { cwd: '/y', tool });
    expect(spawned[1].spec).toMatchObject({ cols: 100, rows: 28 });
    reg.attach(
      'a',
      () => {},
      () => {},
      { grid: { cols: 90, rows: 26 } },
    );
    reg.spawn('c', { cwd: '/z', tool });
    expect(spawned[2].spec).toMatchObject({ cols: 90, rows: 26 });
    reg.spawn('d', { cwd: '/w', tool, cols: 150, rows: 45 }); // a stated start is a client's grid too
    reg.spawn('e', { cwd: '/v', tool });
    expect(spawned[4].spec).toMatchObject({ cols: 150, rows: 45 });
  });

  it('keeps each session grid in the restore list (a moment after the last change), and a restore starts it there', async () => {
    vi.useFakeTimers();
    const first = makeRegistry();
    first.spawn('a', { cwd: '/x', tool });
    await first.flush();
    expect(readSaved().a).toMatchObject(DEFAULT_GRID);
    first.resize('a', 101, 31);
    first.resize('a', 102, 33);
    await first.flush();
    expect(readSaved().a).toMatchObject(DEFAULT_GRID); // a drag: written once it stops
    vi.advanceTimersByTime(1000);
    await first.flush();
    expect(readSaved().a).toMatchObject({ cols: 102, rows: 33 });
    first.disposeAllKeepingState();
    await first.flush();

    const second = makeRegistry(() => true);
    await second.restore();
    expect(spawned[1].spec).toMatchObject({ cols: 102, rows: 33, resume: true });
  });

  it('a host shutting down with a grid write pending still leaves the list as it was (never empty)', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool });
    await reg.flush();
    reg.resize('a', 99, 29);
    reg.disposeAllKeepingState();
    vi.advanceTimersByTime(5000);
    await reg.flush();
    expect(Object.keys(readSaved())).toEqual(['a']);
  });

  it('after a restore, a start with none takes the grid most restored sessions had; an older list (no grid) the default', async () => {
    const write = (entries: Record<string, object>) =>
      fs.writeFileSync(
        sessionsPath,
        JSON.stringify(Object.fromEntries(Object.entries(entries).map(([id, g]) => [id, { cwd: `/${id}`, tool, startedAt: 'x', ...g }]))),
      );
    write({ a: { cols: 100, rows: 30 }, b: { cols: 80, rows: 24 }, c: { cols: 100, rows: 30 } });
    const reg = makeRegistry();
    await reg.restore();
    reg.spawn('d', { cwd: '/d', tool });
    expect(spawned.at(-1)!.spec).toMatchObject({ cols: 100, rows: 30 });
    reg.disposeAllKeepingState();

    spawned = [];
    write({ a: {} });
    const older = makeRegistry();
    await older.restore();
    expect(spawned[0].spec).toMatchObject(DEFAULT_GRID);
    older.spawn('d', { cwd: '/d', tool });
    expect(spawned[1].spec).toMatchObject(DEFAULT_GRID);
  });
});

describe('redraw (⋯ → Reconnect terminal)', () => {
  it('makes the PTY a row smaller and, REDRAW_JIGGLE_MS later, puts it back: two real size changes', () => {
    vi.useFakeTimers();
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, cols: 100, rows: 30 });
    expect(reg.redraw('a')).toBe(true);
    expect(spawned[0].pty.sizes).toEqual([[100, 29]]);
    expect(reg.redraw('a')).toBe(true); // asked again meanwhile: the one under way does
    vi.advanceTimersByTime(REDRAW_JIGGLE_MS - 1);
    expect(spawned[0].pty.sizes).toEqual([[100, 29]]);
    vi.advanceTimersByTime(1);
    expect(spawned[0].pty.sizes).toEqual([
      [100, 29],
      [100, 30],
    ]);
    expect(reg.get('a')).toMatchObject({ cols: 100, rows: 30 }); // its grid, as the clients know it, never changed
  });

  it('puts it back to the grid a client set meanwhile; at the smallest grid it goes a row bigger instead', () => {
    vi.useFakeTimers();
    const reg = makeRegistry();
    reg.spawn('a', { cwd: '/x', tool, cols: 100, rows: 30 });
    reg.redraw('a');
    reg.resize('a', 120, 40);
    vi.advanceTimersByTime(REDRAW_JIGGLE_MS);
    expect(spawned[0].pty.sizes.at(-1)).toEqual([120, 40]);
    reg.spawn('b', { cwd: '/y', tool, cols: 40, rows: 2 });
    reg.redraw('b');
    expect(spawned[1].pty.sizes).toEqual([[40, 3]]);
  });

  it('nothing running: false, and nothing resized (an exited one, an unknown one, one killed before it puts back)', async () => {
    vi.useFakeTimers();
    const reg = makeRegistry();
    expect(reg.redraw('nope')).toBe(false);
    reg.spawn('a', { cwd: '/x', tool, cols: 100, rows: 30 });
    spawned[0].pty.exit(0);
    expect(reg.redraw('a')).toBe(false);
    reg.spawn('b', { cwd: '/y', tool, cols: 100, rows: 30 });
    reg.redraw('b');
    spawned[1].pty.exit(0);
    vi.advanceTimersByTime(REDRAW_JIGGLE_MS);
    expect(spawned[1].pty.sizes).toEqual([[100, 29]]);
  });
});

describe('windowsPty (ConPTY)', () => {
  it('a host on Windows tells its clients, with every screen it sends', () => {
    const reg = new PtyRegistry({
      spawner,
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
      windowsPty: { backend: 'conpty', buildNumber: 19045 },
    });
    reg.spawn('a', { cwd: '/x', tool });
    expect(
      reg.attach(
        'a',
        () => {},
        () => {},
      )?.replay.windowsPty,
    ).toEqual({ backend: 'conpty', buildNumber: 19045 });
  });

  it("a PTY on the bundled ConPTY says its own (PtySession.windowsPty), over the host's", () => {
    const own = { backend: 'conpty' as const, buildNumber: 21376 };
    const onBundled: PtySpawner = (spec) => {
      const pty = Object.assign(new FakePty(), { windowsPty: own });
      spawned.push({ spec, pty });
      return pty;
    };
    const host = { backend: 'conpty' as const, buildNumber: 19045 };
    const reg = new PtyRegistry({
      spawner: onBundled,
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
      windowsPty: host,
    });
    reg.spawn('a', { cwd: '/x', tool });
    expect(
      reg.attach(
        'a',
        () => {},
        () => {},
      )?.replay.windowsPty,
    ).toEqual(own);
    const elsewhere = new PtyRegistry({
      spawner: onBundled,
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
      windowsPty: null,
    });
    elsewhere.spawn('b', { cwd: '/x', tool });
    expect(
      elsewhere.attach(
        'b',
        () => {},
        () => {},
      )?.replay,
    ).not.toHaveProperty('windowsPty');
  });

  it('a host anywhere else says nothing of it', () => {
    const reg = new PtyRegistry({ spawner, hasConversation: () => false, sessionsPath, cwdExists: () => true, windowsPty: null });
    reg.spawn('a', { cwd: '/x', tool });
    expect(
      reg.attach(
        'a',
        () => {},
        () => {},
      )?.replay,
    ).not.toHaveProperty('windowsPty');
  });
});

describe('attaching during a synchronized frame (terminal-rendering.md, "Synchronized output")', () => {
  /** A PTY whose screen copy has parsed everything it emitted (as pty-session's mirror has, by the time a snapshot settles). */
  class FramedPty extends FakePty {
    screen = '';
    snapshots: string[] = [];
    override emit(d: string) {
      this.screen += d;
      super.emit(d);
    }
    serialize() {
      return this.screen;
    }
    serializeSettled() {
      this.snapshots.push(this.screen);
      return Promise.resolve(this.screen);
    }
  }
  const framed = () => {
    const pty = new FramedPty();
    const reg = new PtyRegistry({ spawner: () => pty, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool });
    return { pty, reg };
  };
  const attach = (reg: PtyRegistry, got: string[]) =>
    reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
    )!;

  it('the snapshot waits for the frame end: it has the whole frame, and the client is sent none of it', async () => {
    vi.useFakeTimers();
    const { pty, reg } = framed();
    pty.emit('prompt ');
    pty.emit(`${BSU}top half `);
    const got: string[] = [];
    const att = attach(reg, got);
    expect(pty.snapshots).toEqual([]); // not taken mid-frame
    pty.emit(`bottom half${ESU}`); // pty-session cuts its output at each frame end
    pty.emit('after');
    const ready = await att.ready;
    expect(pty.snapshots).toEqual([`prompt ${BSU}top half bottom half${ESU}`]);
    expect(ready.data).toBe(`prompt ${BSU}top half bottom half${ESU}`);
    att.start();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got).toEqual(['after']);
    expect(att.offset).toBe(`prompt ${BSU}top half bottom half${ESU}`.length);
  });

  it('…for at most FRAME_HOLD_MS: a frame never ended does not keep a terminal from attaching', async () => {
    vi.useFakeTimers();
    const { pty, reg } = framed();
    pty.emit(`${BSU}stuck`);
    const got: string[] = [];
    const att = attach(reg, got);
    vi.advanceTimersByTime(FRAME_HOLD_MS - 1);
    expect(pty.snapshots).toEqual([]);
    vi.advanceTimersByTime(1);
    expect((await att.ready).data).toBe(`${BSU}stuck`);
    att.start();
    pty.emit('more');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got).toEqual(['more']);
  });

  it('between frames it attaches at once', async () => {
    const { pty, reg } = framed();
    pty.emit(`${BSU}whole${ESU}`);
    const att = attach(reg, []);
    expect(pty.snapshots).toEqual([`${BSU}whole${ESU}`]);
    expect((await att.ready).data).toBe(`${BSU}whole${ESU}`);
  });

  it('the session killed while an attach waits for the frame end: ready still answers', async () => {
    vi.useFakeTimers();
    const { pty, reg } = framed();
    pty.emit(`${BSU}half`);
    const att = attach(reg, []);
    const killed = reg.kill('a');
    vi.advanceTimersByTime(10_000);
    await killed;
    // Already answered, it wins the race; never answered, the race says so (a fake timer would never fire: a time-out).
    const ready = await Promise.race([att.ready, Promise.resolve('stuck' as const)]);
    expect(ready).not.toBe('stuck');
  });
});

describe('reattaching where it left off (terminal-rendering.md, "Reattach where you left off")', () => {
  /** A PTY whose screen copy has parsed everything it emitted. */
  class ScreenPty extends FakePty {
    screen = '';
    override emit(d: string) {
      this.screen += d;
      super.emit(d);
    }
    serialize() {
      return this.screen;
    }
    serializeSettled() {
      return Promise.resolve(this.screen);
    }
  }
  const setup = () => {
    const pty = new ScreenPty();
    const reg = new PtyRegistry({ spawner: () => pty, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool, cols: 80, rows: 24 });
    const first = reg.attach(
      'a',
      () => {},
      () => {},
    )!;
    const stream = first.replay.stream;
    first.detach();
    return { pty, reg, stream };
  };
  const resumeAt = (
    reg: PtyRegistry,
    at: { stream: string; offset: number; cols?: number; rows?: number },
    got: string[],
    extra: Partial<AttachOptions> = {},
  ) => {
    const refused: string[] = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
      { resume: { cols: 80, rows: 24, ...at }, onResumeRefused: (why) => refused.push(why), ...extra },
    )!;
    return { att, refused };
  };

  it('is sent exactly what it missed, marked resumed, at the offset its live output starts: nothing twice, nothing lost', async () => {
    vi.useFakeTimers();
    const { pty, reg, stream } = setup();
    pty.emit('seen ');
    const n = 'seen '.length;
    pty.emit('missed one, ');
    pty.emit('missed two');
    const got: string[] = [];
    const { att, refused } = resumeAt(reg, { stream, offset: n }, got);
    pty.emit(' live'); // after it joined: held for it until start(), as for a screen
    const ready = await att.ready;
    expect(ready).toMatchObject({ data: 'missed one, missed two', resumed: true, stream, offset: n + 'missed one, missed two'.length });
    expect(refused).toEqual([]);
    att.start();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got.join('')).toBe(' live');
    expect(ready.data + got.join('')).toBe(pty.screen.slice(n));
  });

  it('a resume while a synchronized frame is open waits for its end: the frame reaches it whole, in what it missed', async () => {
    vi.useFakeTimers();
    const { pty, reg, stream } = setup();
    pty.emit('seen ');
    pty.emit(`${BSU}top half `);
    const got: string[] = [];
    const { att } = resumeAt(reg, { stream, offset: 'seen '.length }, got);
    pty.emit(`bottom half${ESU}`);
    pty.emit('after');
    const ready = await att.ready;
    expect(ready).toMatchObject({ data: `${BSU}top half bottom half${ESU}`, resumed: true });
    att.start();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got).toEqual(['after']);
  });

  it('a frame’s end and what follows it in one chunk: what it missed stops at the frame’s end, the rest comes live, once', async () => {
    vi.useFakeTimers();
    const { pty, reg, stream } = setup();
    pty.emit('seen ');
    pty.emit(`${BSU}top `);
    const got: string[] = [];
    const { att } = resumeAt(reg, { stream, offset: 'seen '.length }, got);
    pty.emit(`bottom${ESU}after`); // one read: it joins at the frame's end, between the two pieces
    const ready = await att.ready;
    expect(ready).toMatchObject({ data: `${BSU}top bottom${ESU}`, resumed: true, offset: pty.screen.length - 'after'.length });
    att.start();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(ready.data + got.join('')).toBe(pty.screen.slice('seen '.length));
  });

  it('from its own offset a tail cut mid-escape or mid-surrogate is never sent; one standing mid-pair gets a screen', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('a😀b');
    const { att, refused } = resumeAt(reg, { stream, offset: 2 }, []);
    const ready = await att.ready;
    expect(ready.resumed).toBeUndefined();
    expect(ready.data).toBe('a😀b');
    expect(refused).toEqual(['split']);
  });

  it('another stream (the same id started again, or another host): a screen', async () => {
    const { pty, reg } = setup();
    pty.emit('hello');
    const { att, refused } = resumeAt(reg, { stream: 'ffffffffffffffff', offset: 0 }, []);
    expect(await att.ready).toMatchObject({ data: 'hello', offset: 5 });
    expect((await att.ready).resumed).toBeUndefined();
    expect(refused).toEqual(['stream']);
  });

  it('a new entry under the same id is a new stream', async () => {
    const { reg, stream } = setup();
    await reg.kill('a');
    reg.spawn('a', { cwd: '/x', tool, cols: 80, rows: 24 });
    const again = reg.attach(
      'a',
      () => {},
      () => {},
    )!;
    expect(again.replay.stream).toMatch(/^[0-9a-f]{16}$/);
    expect(again.replay.stream).not.toBe(stream);
  });

  it('too old for the tail: a screen', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('x'.repeat(RESUME_TAIL_CHARS + 10));
    const { att, refused } = resumeAt(reg, { stream, offset: 5 }, []);
    expect((await att.ready).resumed).toBeUndefined();
    expect(refused).toEqual(['too-old']);
  });

  it('racing a resize (the grid changed after its offset, even back to its own): a screen', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('before ');
    reg.resize('a', 100, 30);
    pty.emit('reflowed ');
    reg.resize('a', 80, 24);
    pty.emit('reflowed again');
    const { att, refused } = resumeAt(reg, { stream, offset: 'before '.length }, []);
    expect((await att.ready).resumed).toBeUndefined();
    expect(refused).toEqual(['resized']);
  });

  it('a resize it saw (before its offset) does not stop it', async () => {
    const { pty, reg, stream } = setup();
    reg.resize('a', 100, 30);
    reg.resize('a', 80, 24);
    pty.emit('seen');
    const { att } = resumeAt(reg, { stream, offset: 4 }, []);
    pty.emit('');
    expect(await att.ready).toMatchObject({ data: '', resumed: true, offset: 4 });
  });

  it('stating a grid other than the PTY’s takes it (a resize) and gets a screen at it', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('seen');
    reg.resize('a', 100, 30); // another client
    const { att, refused } = resumeAt(reg, { stream, offset: 4 }, [], { grid: { cols: 80, rows: 24 } });
    const ready = await att.ready;
    expect(ready.resumed).toBeUndefined();
    expect(ready).toMatchObject({ cols: 80, rows: 24 });
    expect(refused).toEqual(['grid']);
  });

  it('stating its own grid, which is the PTY’s: resumed (no resize)', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('seen more');
    const sizes = pty.sizes.length;
    const { att } = resumeAt(reg, { stream, offset: 4 }, [], { grid: { cols: 80, rows: 24 } });
    expect(await att.ready).toMatchObject({ data: ' more', resumed: true });
    expect(pty.sizes.length).toBe(sizes);
  });

  it('while its agent is being redrawn: a screen', async () => {
    vi.useFakeTimers();
    const { pty, reg, stream } = setup();
    pty.emit('seen');
    reg.redraw('a');
    const { att, refused } = resumeAt(reg, { stream, offset: 4 }, []);
    expect((await att.ready).resumed).toBeUndefined();
    expect(refused).toEqual(['busy']);
    pty.emit('repaint at 80x23 ');
    vi.advanceTimersByTime(REDRAW_JIGGLE_MS);
    // The jiggle's resizes are grid changes: a client from before the last of them gets a screen after it too…
    const again = resumeAt(reg, { stream, offset: 4 }, []);
    expect((await again.att.ready).resumed).toBeUndefined();
    expect(again.refused).toEqual(['resized']);
    // …one that saw everything before it is sent what came after.
    pty.emit('repaint at 80x24');
    const after = resumeAt(reg, { stream, offset: 'seenrepaint at 80x23 '.length }, []);
    expect(await after.att.ready).toMatchObject({ data: 'repaint at 80x24', resumed: true });
  });

  it('an agent that exited: its last screen and its end, no resume', async () => {
    const { pty, reg, stream } = setup();
    pty.emit('bye');
    pty.exit(0);
    const { att } = resumeAt(reg, { stream, offset: 0 }, []);
    expect(att.exitedWith).toBe(0);
    expect((await att.ready).resumed).toBeUndefined();
  });

  it('a metered client’s acks start from where it resumed: what it missed is not counted, as a screen is not', async () => {
    vi.useFakeTimers();
    const { pty, reg, stream } = setup();
    const replays: Array<{ offset: number; stream: string }> = [];
    pty.emit('seen ');
    pty.emit('m'.repeat(60_000));
    const got: string[] = [];
    const { att } = resumeAt(reg, { stream, offset: 5 }, got, { metered: true, onReplay: (r) => replays.push(r) });
    const ready = await att.ready;
    expect(ready).toMatchObject({ resumed: true, offset: 60_005 });
    att.start();
    // 60 000 more, unacked: under HIGH_WATERMARK only if the 60 000 it missed were not counted.
    pty.emit('l'.repeat(60_000));
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got.join('').length).toBe(60_000);
    // 50 000 more: now it is behind, and nothing more is sent to it.
    pty.emit('b'.repeat(50_000));
    vi.advanceTimersByTime(COALESCE_MS);
    pty.emit('held');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(got.join('').length).toBe(110_000);
    // Acking what it was sent since it resumed (110 000) brings it to 0: caught up, a screen at the offset it stands at.
    att.ack(110_000);
    vi.advanceTimersByTime(CATCH_UP_MIN_MS);
    await vi.waitFor(() => expect(replays).toHaveLength(1));
    expect(replays[0]).toMatchObject({ stream, offset: pty.screen.length });
    // …which is a position it can resume from in turn (StreamPosition takes a catch-up screen's offset).
    pty.emit(' later');
    const again = resumeAt(reg, { stream, offset: replays[0].offset }, []);
    expect(await again.att.ready).toMatchObject({ data: ' later', resumed: true });
  });

  it('across a restart in place the stream goes on: resumed with exactly what a client attached all along was sent', async () => {
    vi.useFakeTimers();
    const ptys: ScreenPty[] = [];
    const reg = new PtyRegistry({
      spawner: () => {
        ptys.push(new ScreenPty());
        return ptys.at(-1)!;
      },
      hasConversation: () => false,
      sessionsPath,
      cwdExists: () => true,
    });
    reg.spawn('a', { cwd: '/x', tool, cols: 80, rows: 24 });
    // Attached all along: through the restart it is sent output only — no screen, no reset.
    const steady: string[] = [];
    const replays: unknown[] = [];
    const all = reg.attach(
      'a',
      (d) => steady.push(d),
      () => {},
      { onReplay: (r) => replays.push(r) },
    )!;
    const { stream, offset: from } = await all.ready;
    all.start();
    ptys[0].emit('old screen ');
    vi.advanceTimersByTime(COALESCE_MS);
    const droppedAt = from + steady.join('').length; // another client drew up to here, and dropped
    ptys[0].emit('old last words ');
    const restarted = reg.restart('a');
    // While it restarts: a screen (busy), never what it missed.
    const during = resumeAt(reg, { stream, offset: droppedAt }, []);
    expect((await during.att.ready).resumed).toBeUndefined();
    expect(during.refused).toEqual(['busy']);
    during.att.detach();
    ptys[0].exit(0);
    await restarted;
    expect(ptys).toHaveLength(2);
    ptys[1].emit('new agent draws');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(replays).toEqual([]);
    expect(steady.join('')).toBe('old screen old last words new agent draws');
    // After it: the output it missed, old process and new, is what the client attached all along was sent from there.
    const { att, refused } = resumeAt(reg, { stream, offset: droppedAt }, []);
    const ready = await att.ready;
    expect(refused).toEqual([]);
    expect(ready).toMatchObject({ resumed: true, stream, data: steady.join('').slice(droppedAt - from) });
    expect(ready.offset).toBe(from + steady.join('').length);
    // A new process has a new screen copy: a screen sent now is the new agent's alone (what a fresh terminal gets).
    const fresh = reg.attach(
      'a',
      () => {},
      () => {},
    )!;
    expect((await fresh.ready).data).toBe('new agent draws');
  });

  describe('a client that fell behind is caught up from the tail when it may be ("Flow control and coalescing")', () => {
    /** A paced client (the only one: a FakePty can't pause, so it falls behind) behind after the 110 000 it was sent. */
    async function fallenBehind(extra: Partial<AttachOptions> = {}) {
      vi.useFakeTimers();
      const { pty, reg, stream } = setup();
      const got: string[] = [];
      const replays: ReplaySnapshot[] = [];
      const att = reg.attach(
        'a',
        (d) => got.push(d),
        () => {},
        { metered: true, onReplay: (r) => replays.push(r), ...extra },
      )!;
      await att.ready;
      att.start();
      pty.emit('a'.repeat(60_000));
      vi.advanceTimersByTime(COALESCE_MS);
      pty.emit('b'.repeat(50_000)); // now behind: nothing more is sent to it
      vi.advanceTimersByTime(COALESCE_MS);
      const sent = got.join('');
      expect(sent).toHaveLength(110_000);
      /** It drew all it was sent: caught up once CATCH_UP_MIN_MS has passed since its screen. */
      const catchUp = async () => {
        att.ack(got.join('').length);
        vi.advanceTimersByTime(CATCH_UP_MIN_MS);
        await vi.waitFor(() => expect(replays.length).toBeGreaterThan(0));
      };
      return { pty, reg, stream, att, got, replays, sent, catchUp };
    }

    it('is sent exactly what it missed, marked resumed, at the offset its live output goes on from: no screen, no reset', async () => {
      const f = await fallenBehind();
      f.pty.emit('missed 1, ');
      vi.advanceTimersByTime(COALESCE_MS);
      f.pty.emit('missed 2'); // pending in a window when it catches up
      await f.catchUp();
      expect(f.replays).toEqual([
        expect.objectContaining({ data: 'missed 1, missed 2', resumed: true, stream: f.stream, offset: f.pty.screen.length }),
      ]);
      f.pty.emit(' live');
      vi.advanceTimersByTime(COALESCE_MS);
      // Its output, what it missed and live output again: the stream, nothing twice, nothing lost.
      expect(f.sent + f.replays[0].data + f.got.join('').slice(f.sent.length)).toBe(f.pty.screen);
    });

    it('what it missed no longer all in the tail: a screen', async () => {
      const f = await fallenBehind();
      f.pty.emit('m'.repeat(RESUME_TAIL_CHARS + 10));
      await f.catchUp();
      expect(f.replays[0].resumed).toBeUndefined();
      expect(f.replays[0].data).toBe(f.pty.screen);
    });

    it('the PTY resized after its output stopped: a screen', async () => {
      const f = await fallenBehind();
      f.pty.emit('missed, drawn for 80 columns');
      f.reg.resize('a', 100, 30);
      f.pty.emit('drawn for 100 columns');
      await f.catchUp();
      expect(f.replays[0]).toMatchObject({ cols: 100, rows: 30, data: f.pty.screen });
      expect(f.replays[0].resumed).toBeUndefined();
    });

    it('caught up inside a synchronized frame: waits for its end, and the frame is in what it missed, whole', async () => {
      const f = await fallenBehind();
      vi.advanceTimersByTime(CATCH_UP_MIN_MS - FRAME_HOLD_MS / 2); // its catch-up falls due inside the frame, before its cap
      f.pty.emit(`${BSU}half`);
      f.att.ack(f.got.join('').length);
      vi.advanceTimersByTime(FRAME_HOLD_MS / 2);
      expect(f.replays).toEqual([]);
      f.pty.emit(`rest${ESU}`);
      expect(f.replays).toEqual([expect.objectContaining({ data: `${BSU}halfrest${ESU}`, resumed: true })]);
    });

    it('behind again before it drew past what it missed: the next catch-up is a screen', async () => {
      const f = await fallenBehind();
      f.pty.emit('missed');
      await f.catchUp();
      expect(f.replays[0]).toMatchObject({ resumed: true, data: 'missed' });
      f.pty.emit('c'.repeat(60_000));
      vi.advanceTimersByTime(COALESCE_MS);
      f.pty.emit('d'.repeat(50_000)); // behind again, nothing sent since acked
      vi.advanceTimersByTime(COALESCE_MS);
      f.pty.emit('missed again');
      f.att.ack(110_000);
      vi.advanceTimersByTime(CATCH_UP_MIN_MS);
      await vi.waitFor(() => expect(f.replays).toHaveLength(2));
      expect(f.replays[1].resumed).toBeUndefined();
      expect(f.replays[1].data).toBe(f.pty.screen);
    });

    it('`work attach` (screen-only catch-ups) is sent a screen', async () => {
      const f = await fallenBehind({ screenOnlyCatchUp: true });
      f.pty.emit('missed');
      await f.catchUp();
      expect(f.replays[0].resumed).toBeUndefined();
      expect(f.replays[0].data).toBe(f.pty.screen);
    });

    it('while its agent is being redrawn: a screen', async () => {
      const f = await fallenBehind();
      f.pty.emit('missed');
      f.att.ack(110_000);
      vi.advanceTimersByTime(CATCH_UP_MIN_MS - REDRAW_JIGGLE_MS / 2);
      expect(f.reg.redraw('a')).toBe(true);
      await f.catchUp();
      expect(f.replays[0].resumed).toBeUndefined();
    });
  });
});

describe('a screen that cannot be taken (the screen copy failed: null, logged)', () => {
  /** A PTY whose screen copy fails once `broken` is set. */
  class FailingScreenPty extends FakePty {
    screen = '';
    broken = false;
    /** The screen copy rejects (once `broken` is set) instead of answering null. */
    rejects = false;
    override emit(d: string) {
      this.screen += d;
      super.emit(d);
    }
    serialize() {
      return this.broken ? null : this.screen;
    }
    serializeSettled() {
      if (this.broken && this.rejects) return Promise.reject(new Error('gone'));
      return Promise.resolve(this.broken ? null : this.screen);
    }
  }
  const setup = () => {
    const pty = new FailingScreenPty();
    const reg = new PtyRegistry({ spawner: () => pty, hasConversation: () => false, sessionsPath, cwdExists: () => true });
    reg.spawn('a', { cwd: '/x', tool, cols: 80, rows: 24 });
    return { pty, reg };
  };
  const reports: string[] = [];
  const reporting = <T>(fn: () => Promise<T>) => {
    reports.length = 0;
    return withReporter((level, text) => reports.push(`${level}: ${text}`), fn);
  };
  /** A paced client, fallen behind and caught up while its screen copy fails: what it was sent. */
  async function caughtUpWithNoScreen(extra: Partial<AttachOptions> = {}, rejects = false) {
    vi.useFakeTimers();
    const { pty, reg } = setup();
    const got: string[] = [];
    const replays: Array<{ data: string; stream: string; offset: number; resumed?: true }> = [];
    const att = reg.attach(
      'a',
      (d) => got.push(d),
      () => {},
      { metered: true, onReplay: (r) => replays.push(r), ...extra },
    )!;
    await att.ready;
    att.start();
    pty.emit('a'.repeat(60_000));
    vi.advanceTimersByTime(COALESCE_MS);
    pty.emit('b'.repeat(50_000)); // now behind: nothing more is sent to it
    vi.advanceTimersByTime(COALESCE_MS);
    pty.emit('missed');
    pty.emit('m'.repeat(RESUME_TAIL_CHARS)); // more than the tail holds: a screen, not what it missed
    vi.advanceTimersByTime(COALESCE_MS);
    pty.broken = true;
    pty.rejects = rejects;
    att.ack(110_000);
    vi.advanceTimersByTime(CATCH_UP_MIN_MS);
    pty.emit('live');
    await vi.waitFor(() => expect(got.join('')).toContain('live'));
    return { got, replays };
  }

  it('a first attach still attaches, on an empty screen, and says so', async () => {
    await reporting(async () => {
      const { pty, reg } = setup();
      pty.emit('on screen');
      pty.broken = true;
      const att = reg.attach(
        'a',
        () => {},
        () => {},
      )!;
      expect(await att.ready).toMatchObject({ data: '', offset: 'on screen'.length });
      expect(reports).toEqual([expect.stringMatching(/^warn: a: a terminal's screen couldn't be taken; it attached with an empty one/)]);
    });
  });

  it('a catch-up sends no screen to draw over the tab’s: nothing to draw, no stream (it no longer resumes from there), then live output', async () => {
    await reporting(async () => {
      const { got, replays } = await caughtUpWithNoScreen();
      expect(replays).toEqual([expect.objectContaining({ data: '', stream: '', resumed: true })]);
      expect(got.join('')).not.toContain('missed');
      expect(reports).toEqual([
        expect.stringMatching(/^warn: a: a terminal's catch-up screen couldn't be taken; it keeps the screen it has/),
      ]);
    });
  });

  it('`work attach` (screen-only catch-ups, never resumes) is sent no replay at all: its screen is kept', async () => {
    await reporting(async () => {
      const { replays } = await caughtUpWithNoScreen({ screenOnlyCatchUp: true });
      expect(replays).toEqual([]);
      expect(reports).toHaveLength(1);
    });
  });

  it('a screen copy that throws instead: the same, logged', async () => {
    await reporting(async () => {
      const { pty, reg } = setup();
      pty.serializeSettled = () => Promise.reject(new Error('gone'));
      const att = reg.attach(
        'a',
        () => {},
        () => {},
      )!;
      await new Promise((r) => setTimeout(r, 0)); // its promise chain settles
      // Never left waiting: a terminal with no first frame takes no input.
      expect(await Promise.race([att.ready, Promise.resolve('stuck' as const)])).toMatchObject({ data: '' });
      expect(reports).toEqual([expect.stringMatching(/^warn: a: a terminal's screen couldn't be taken; it attached with an empty one/)]);
    });
  });

  it('a catch-up whose screen copy rejects: the same as one that is null (no screen, no stream, resumed), then live output', async () => {
    await reporting(async () => {
      const { got, replays } = await caughtUpWithNoScreen({}, true);
      expect(replays).toEqual([expect.objectContaining({ data: '', stream: '', resumed: true })]);
      expect(got.join('')).not.toContain('missed');
      expect(got.join('')).toContain('live');
    });
  });
});
