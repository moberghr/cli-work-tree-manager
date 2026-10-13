import fs from 'node:fs';
import { agentById } from '../agents/index.js';
import { loadConfig } from '../platform/config.js';
import { PtySession } from './pty-session.js';
import { atomicWriteFile, ensureFile, withFileLockSync } from '../platform/fs-safe.js';
import { dbPtySessions, type PtySessionsStore } from './pty-sessions-file.js';
import { isPersistedPty, keepEnv, type PersistedPty, type PersistedPtys, type PtyInfo, type SpawnSpec } from './pty-host-protocol.js';
import { logSwallowed, swallow } from '../platform/best-effort.js';

const REPLAY_MAX = 256 * 1024;

/** How long an exited PTY lingers before it's dropped from the persisted
 *  list. During a Windows shutdown/logoff the child Claudes are often killed
 *  a moment BEFORE the host; dropping them immediately would erase exactly
 *  the list we need to restore after the reboot. A host that's itself about
 *  to die never reaches the timer. */
const FORGET_EXITED_MS = 5_000;

/** Minimal PTY surface the registry needs — `PtySession` in production, a
 *  fake in tests. */
export interface PtyLike {
  readonly pty: { pid: number };
  readonly exited: boolean;
  onExit?: (code: number) => void;
  setOutputHandler(h?: (data: string) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  /** Serialized screen state (see PtySession.serialize). Optional so test
   *  fakes can fall back to the raw replay buffer. */
  serialize?(): string;
  /** The serialized screen once everything written so far is parsed (see
   *  PtySession.serializeSettled). Optional: a fake's screen is its raw buffer. */
  serializeSettled?(): Promise<string>;
  /** Visible screen as plain text (PtySession.screenText). */
  screenText?(): string;
}

/** What a newly attached client is sent first: the screen as it stands,
 *  plus the grid it was drawn for. */
export interface ReplaySnapshot {
  data: string;
  cols: number;
  rows: number;
}

export type PtySpawner = (spec: SpawnSpec & { resume: boolean }) => PtyLike;

export const defaultSpawner: PtySpawner = (spec) =>
  new PtySession(spec.cwd, spec.cols ?? 120, spec.rows ?? 32, undefined, {
    tool: spec.tool,
    resume: spec.resume,
    port: spec.port,
    unsafe: spec.unsafe,
    initialPrompt: spec.initialPrompt,
    env: spec.env,
  });

interface Entry {
  id: string;
  spec: Omit<PersistedPty, 'startedAt'>;
  pty: PtyLike;
  cols: number;
  rows: number;
  startedAt: string;
  restored: boolean;
  replay: string;
  subscribers: Set<(data: string) => void>;
  exitSubscribers: Set<(code: number) => void>;
  /** Set once the process exited (the entry lingers FORGET_EXITED_MS). */
  exitCode: number | null;
  /** When it last printed anything (ms): an idle Claude at its prompt prints nothing. */
  lastOutputAt: number;
  /** Its agent is being restarted (restart): the old process's end isn't the session's, a spawn starts no
   *  second one, and a second restart gets this one's outcome. */
  restarting?: Promise<PtyInfo | null>;
  /** The environment it was started with, in memory only (never in the restore list: it can hold secrets), so a
   *  restart runs as the session did; a restore after the host restarts has only what `hostEnv` kept. */
  env?: Record<string, string>;
}

export interface RegistryDeps {
  /** The env variable names to keep for a restore (default: config `hostEnv`). */
  keepEnvNames?: () => string[];
  spawner?: PtySpawner;
  /** Its agent can resume a conversation in this folder (default: the agent's own check, agents/). */
  hasConversation?: (cwd: string, tool: string) => boolean;
  /** Where the restore list lives. Default: state.db. */
  sessions?: PtySessionsStore;
  /** Keep the restore list in this JSON file instead (tests, which must
   *  never touch the user's state.db). */
  sessionsPath?: string;
  cwdExists?: (cwd: string) => boolean;
}

/** A restore list in a plain JSON file, written under the file lock. */
export function fileSessionsStore(file: string): PtySessionsStore {
  return {
    read() {
      const out: PersistedPtys = {};
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
        if (raw && typeof raw === 'object') {
          for (const [id, entry] of Object.entries(raw)) if (isPersistedPty(entry)) out[id] = entry;
        }
      } catch {
        /* missing or unreadable: nothing to restore */
      }
      return out;
    },
    write(all) {
      ensureFile(file, '{}');
      withFileLockSync(file, () => atomicWriteFile(file, JSON.stringify(all, null, 2)));
    },
  };
}

/**
 * Owns every live PTY in the host process and mirrors the set to the
 * restore list (state.db `pty_sessions`, see pty-sessions-file.ts) so a
 * host restart (crash, `--restart`, reboot) can respawn them with
 * `--continue`. Writes replace the list in one transaction, so two hosts
 * racing at startup can't interleave.
 */
export class PtyRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly spawner: PtySpawner;
  private readonly hasConversation: (cwd: string, tool: string) => boolean;
  private readonly store: PtySessionsStore;
  private readonly cwdExists: (cwd: string) => boolean;
  private readonly keepEnvNames: () => string[];
  /** Serializes persistence writes inside this process. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(deps: RegistryDeps = {}) {
    this.spawner = deps.spawner ?? defaultSpawner;
    this.hasConversation = deps.hasConversation ?? ((cwd, tool) => agentById(tool).launch.canResume(cwd));
    this.store = deps.sessions ?? (deps.sessionsPath ? fileSessionsStore(deps.sessionsPath) : dbPtySessions);
    this.cwdExists = deps.cwdExists ?? ((p) => fs.existsSync(p));
    this.keepEnvNames = deps.keepEnvNames ?? (() => loadConfig()?.hostEnv ?? []);
  }

  list(): PtyInfo[] {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  get(id: string): PtyInfo | null {
    const e = this.entries.get(id);
    return e ? this.info(e) : null;
  }

  /** Spawn unless a live PTY already exists for `id` (idempotent). */
  spawn(id: string, spec: SpawnSpec & { keptEnv?: Record<string, string> }, restored = false): PtyInfo {
    const existing = this.entries.get(id);
    if (existing && (!existing.pty.exited || existing.restarting)) return this.info(existing);

    // A spawn from a shell keeps the variables config `hostEnv` names; a
    // restore — or a respawn without a shell (the Terminal tab) — runs with
    // the host's environment plus what its session kept.
    const kept = spec.env ? keepEnv(spec.env, this.keepEnvNames()) : (spec.keptEnv ?? existing?.spec.keptEnv);
    if (!spec.env && kept) spec = { ...spec, env: this.respawnEnv(kept) };

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 32;
    const pty = this.spawner({
      ...spec,
      cols,
      rows,
      // `--continue` hard-errors in a directory Claude never ran in;
      // `--fresh` opts out even when one exists.
      resume: !spec.fresh && this.hasConversation(spec.cwd, spec.tool.cmd),
    });
    const entry: Entry = {
      id,
      // Only what a restore may reuse: env/prompt/fresh are one-shot (and
      // env can hold secrets), so they never reach pty-sessions.json — but
      // the variables config `hostEnv` names do (keepEnv), so a restore after
      // a reboot gets the JAVA_HOME / PATH it was started with.
      spec: { cwd: spec.cwd, tool: spec.tool, port: spec.port, unsafe: spec.unsafe, ...(kept ? { keptEnv: kept } : {}) },
      env: spec.env as Record<string, string> | undefined,
      pty,
      cols,
      rows,
      startedAt: new Date().toISOString(),
      restored,
      replay: '',
      subscribers: new Set(),
      exitSubscribers: new Set(),
      exitCode: null,
      lastOutputAt: Date.now(),
    };
    this.wire(entry, pty);
    this.entries.set(id, entry);
    void this.persist();
    return this.info(entry);
  }

  /** The env a spawn without a shell runs with: the host's, plus what its session kept (spawn). */
  private respawnEnv(kept: Record<string, string> | undefined): Record<string, string> | undefined {
    return kept ? { ...(process.env as Record<string, string>), ...kept } : undefined;
  }

  /** `pty` becomes the entry's process: its output to the entry's clients, its exit told to them (then forgotten). */
  private wire(entry: Entry, pty: PtyLike): void {
    const id = entry.id;
    entry.pty = pty;
    // Raw history is only a fallback for PTYs that can't serialize their
    // screen (test fakes) — real sessions replay PtySession.serialize().
    const keepRaw = !pty.serialize;
    pty.setOutputHandler((data) => {
      entry.lastOutputAt = Date.now();
      if (keepRaw) {
        entry.replay += data;
        if (entry.replay.length > REPLAY_MAX) {
          entry.replay = entry.replay.slice(entry.replay.length - REPLAY_MAX);
        }
      }
      for (const cb of entry.subscribers) {
        try {
          cb(data);
        } catch {
          /* subscriber gone */
        }
      }
    });
    pty.onExit = (code) => {
      entry.exitCode = code;
      for (const cb of entry.exitSubscribers) {
        try {
          cb(code);
        } catch {
          /* */
        }
      }
      setTimeout(() => {
        // Only forget it if nothing respawned under the same id meanwhile.
        if (this.entries.get(id) === entry) {
          this.entries.delete(id);
          void this.persist();
        }
      }, FORGET_EXITED_MS).unref?.();
    };
  }

  /** The live PTY's visible screen as text; null when there is none (or
   *  it can't render one — test fakes). */
  screen(id: string): string | null {
    const e = this.entries.get(id);
    if (!e || e.pty.exited || !e.pty.screenText) return null;
    return e.pty.screenText();
  }

  write(id: string, data: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.pty.exited) return false;
    e.pty.write(data);
    return true;
  }

  /** Last writer wins — with several clients attached (browser + a real
   *  terminal) the host calls this when one resizes AND when one is typed in
   *  (its own grid again), so the client used last sets the grid, like
   *  tmux's `window-size latest` (pty-host.ts). */
  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e || e.pty.exited) return;
    if (cols < 2 || rows < 2 || (cols === e.cols && rows === e.rows)) return;
    e.cols = cols;
    e.rows = rows;
    e.pty.resize(cols, rows);
  }

  /**
   * Attach a client: the screen snapshot, a disposer, and — for a real
   * session — `ready`, the snapshot once the screen has parsed everything
   * that arrived before this attach, then `start()` once it was sent.
   *
   * Output reaches clients the moment it arrives, but the screen parses it a
   * moment later (xterm's write is queued). A client attaching in between got
   * a snapshot without that output and subscribed too late to be sent it: it
   * was lost (a Linux PTY answers fast enough to land there). So output
   * arriving from the attach on is held for this client until `start()`, and
   * `ready` is the screen exactly as of the attach — nothing lost, nothing
   * twice. `replay` (taken at once) is for screens with no parsing step.
   */
  attach(
    id: string,
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ): {
    replay: ReplaySnapshot;
    ready: Promise<ReplaySnapshot>;
    start: () => void;
    detach: () => void;
    exitedWith: number | null;
  } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    // Attaching to one that already exited (inside the linger window): its
    // exit subscribers have fired, so tell this client now — otherwise it
    // would sit on a dead screen, its input silently dropped.
    const exitedWith = e.pty.exited && !e.restarting ? (e.exitCode ?? 0) : null;
    const settled = e.pty.serializeSettled;
    // Held output while the settled snapshot is taken; null = passed straight on.
    let held: string[] | null = settled ? [] : null;
    const sub = (d: string) => (held ? held.push(d) : onData(d));
    if (exitedWith === null) {
      e.subscribers.add(sub);
      e.exitSubscribers.add(onExit);
    }
    const snapshot = (data: string): ReplaySnapshot => ({ data, cols: e.cols, rows: e.rows });
    const replay = snapshot(e.pty.serialize?.() || e.replay);
    return {
      exitedWith,
      replay,
      ready: settled ? settled.call(e.pty).then((d) => snapshot(d || e.replay)) : Promise.resolve(replay),
      start: () => {
        const q = held;
        held = null;
        for (const d of q ?? []) onData(d);
      },
      detach: () => {
        e.subscribers.delete(sub);
        e.exitSubscribers.delete(onExit);
      },
    };
  }

  /**
   * Explicit kill (worktree removal, user closed the session). Removed
   * from the persisted list so it is NOT restored.
   *
   * Resolves once the process has actually exited (or after `timeoutMs`):
   * on Windows a just-killed process still holds its cwd for a moment, and
   * the caller's next step is usually deleting that very directory.
   */
  async kill(id: string, timeoutMs = 3000): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    // The terminals attached to it are told it ended (and so offer Enter to start it again):
    // dropped silently, a dashboard tab kept a connection to nothing and took no input.
    const attached = [...e.exitSubscribers];
    e.subscribers.clear();
    e.exitSubscribers.clear();
    const exited = e.pty.exited
      ? Promise.resolve(e.exitCode ?? 0)
      : new Promise<number>((resolve) => {
          const timer = setTimeout(() => resolve(0), timeoutMs);
          e.pty.onExit = (code) => {
            clearTimeout(timer);
            resolve(code);
          };
        });
    e.pty.dispose();
    const [code] = await Promise.all([exited, this.persist()]);
    for (const cb of attached) {
      try {
        cb(code);
      } catch {
        /* that client is gone */
      }
    }
  }

  /**
   * Its agent stopped and started again in place, resuming its conversation (a
   * tool that updated runs its new version). The new process goes into the same
   * entry, so the terminals attached stay attached (and a detach still finds them),
   * see the new one draw, and one that attaches meanwhile joins it; the restore
   * list keeps it. Null when there's no live PTY of that id.
   *
   * Never two agents on one conversation: an old one that hasn't exited within
   * `timeoutMs` is left running and tracked, and the restart fails. A new one that
   * can't start (its tool gone mid-update) ends the session as a kill does, its
   * terminals told so.
   */
  restart(id: string, timeoutMs = 3000): Promise<PtyInfo | null> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(null);
    // Asked twice (two windows, the CLI): both get the one restart's outcome, failure included.
    if (e.restarting) return e.restarting;
    if (e.pty.exited) return Promise.resolve(null);
    const running = this.restartEntry(e, timeoutMs).finally(() => {
      e.restarting = undefined;
    });
    e.restarting = running;
    return running;
  }

  private async restartEntry(e: Entry, timeoutMs: number): Promise<PtyInfo | null> {
    const id = e.id;
    const old = e.pty;
    const usual = old.onExit;
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      old.onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      old.dispose();
    });
    if (this.entries.get(id) !== e) return this.get(id); // killed meanwhile
    if (!stopped) {
      old.onExit = usual; // still ours: its exit goes the usual way
      throw new Error(`its agent didn't stop within ${Math.round(timeoutMs / 1000)} s; it is left running`);
    }
    let pty: PtyLike;
    try {
      pty = this.spawner({
        ...e.spec,
        env: e.env ?? this.respawnEnv(e.spec.keptEnv),
        cols: e.cols,
        rows: e.rows,
        resume: this.hasConversation(e.spec.cwd, e.spec.tool.cmd),
      });
    } catch (err) {
      // Nothing runs now: tell its terminals (they offer Enter to start it again) and forget it, as a kill does.
      this.entries.delete(id);
      const attached = [...e.exitSubscribers];
      e.subscribers.clear();
      e.exitSubscribers.clear();
      await this.persist();
      for (const cb of attached) {
        try {
          cb(1);
        } catch {
          /* that client is gone */
        }
      }
      throw err;
    }
    e.exitCode = null;
    e.replay = '';
    e.startedAt = new Date().toISOString();
    e.restored = false;
    e.lastOutputAt = Date.now();
    this.wire(e, pty);
    void this.persist();
    return this.info(e);
  }

  /**
   * Respawn everything in the persisted list. Called once at host startup.
   * Worktrees that no longer exist are dropped.
   */
  async restore(): Promise<string[]> {
    const saved = this.readPersisted();
    const restored: string[] = [];
    for (const [id, entry] of Object.entries(saved)) {
      if (!this.cwdExists(entry.cwd)) continue;
      try {
        this.spawn(id, entry, true);
        restored.push(id);
      } catch (err) {
        // One bad entry (tool missing, cwd unreadable) mustn't block the rest.
        logSwallowed(`restore session ${id} in ${entry.cwd}`, err);
      }
    }
    await this.persist();
    return restored;
  }

  /** Host shutdown: kill every PTY but KEEP the persisted list, so the next
   *  host start restores them. */
  disposeAllKeepingState(): void {
    for (const e of this.entries.values()) {
      e.pty.onExit = undefined;
      e.subscribers.clear();
      e.exitSubscribers.clear();
      e.pty.dispose();
    }
    this.entries.clear();
  }

  /** Resolves once every queued persistence write has landed. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private info(e: Entry): PtyInfo {
    return {
      id: e.id,
      cwd: e.spec.cwd,
      pid: e.pty.pty.pid,
      exited: e.pty.exited,
      cols: e.cols,
      rows: e.rows,
      startedAt: e.startedAt,
      restored: e.restored,
      clients: e.subscribers.size,
      lastOutputAt: new Date(e.lastOutputAt).toISOString(),
      tool: e.spec.tool.cmd,
    };
  }

  private readPersisted(): PersistedPtys {
    try {
      return this.store.read();
    } catch (err) {
      logSwallowed('read the PTY restore list', err);
      return {};
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedPtys = {};
    // Exited entries still lingering (see FORGET_EXITED_MS) are kept on
    // purpose — dropping them on an unrelated write would defeat the delay.
    for (const e of this.entries.values()) {
      snapshot[e.id] = { ...e.spec, startedAt: e.startedAt };
    }
    this.writeChain = this.writeChain
      .then(() => this.store.write(snapshot))
      .catch(swallow('persist the PTY restore list (next change retries)'));
    return this.writeChain;
  }
}
