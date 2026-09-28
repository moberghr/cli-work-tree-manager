import fs from 'node:fs';
import { PtySession } from '../tui/session.js';
import { atomicWriteFile, ensureFile, withFileLock } from './fs-safe.js';
import { hasClaudeConversation } from './claude-activity.js';
import { ptySessionsPath, type PtyInfo, type SpawnSpec } from './pty-host-protocol.js';

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

interface PersistedEntry extends SpawnSpec {
  startedAt: string;
}
type PersistedFile = Record<string, PersistedEntry>;

interface Entry {
  id: string;
  spec: SpawnSpec;
  pty: PtyLike;
  cols: number;
  rows: number;
  startedAt: string;
  restored: boolean;
  replay: string;
  subscribers: Set<(data: string) => void>;
  exitSubscribers: Set<(code: number) => void>;
}

export interface RegistryDeps {
  spawner?: PtySpawner;
  hasConversation?: (cwd: string) => boolean;
  sessionsPath?: string;
  cwdExists?: (cwd: string) => boolean;
}

/**
 * Owns every live PTY in the host process and mirrors the set to
 * `~/.work/pty-sessions.json` so a host restart (crash, `--restart`,
 * reboot) can respawn them with `--continue`. The file is the host's alone
 * in practice, but it's still written under the file lock (§5.2) — two
 * hosts racing at startup must not interleave writes.
 */
export class PtyRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly spawner: PtySpawner;
  private readonly hasConversation: (cwd: string) => boolean;
  private readonly sessionsPath: string;
  private readonly cwdExists: (cwd: string) => boolean;
  /** Serializes persistence writes inside this process. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(deps: RegistryDeps = {}) {
    this.spawner = deps.spawner ?? defaultSpawner;
    this.hasConversation = deps.hasConversation ?? hasClaudeConversation;
    this.sessionsPath = deps.sessionsPath ?? ptySessionsPath();
    this.cwdExists = deps.cwdExists ?? ((p) => fs.existsSync(p));
  }

  list(): PtyInfo[] {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  get(id: string): PtyInfo | null {
    const e = this.entries.get(id);
    return e ? this.info(e) : null;
  }

  /** Spawn unless a live PTY already exists for `id` (idempotent). */
  spawn(id: string, spec: SpawnSpec, restored = false): PtyInfo {
    const existing = this.entries.get(id);
    if (existing && !existing.pty.exited) return this.info(existing);

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 32;
    const pty = this.spawner({
      ...spec,
      cols,
      rows,
      // `--continue` hard-errors in a directory Claude never ran in;
      // `--fresh` opts out even when one exists.
      resume: !spec.fresh && this.hasConversation(spec.cwd),
    });
    const entry: Entry = {
      id,
      // Only what a restore may reuse: env/prompt/fresh are one-shot (and
      // env can hold secrets), so they never reach pty-sessions.json.
      spec: { cwd: spec.cwd, tool: spec.tool, port: spec.port, unsafe: spec.unsafe },
      pty,
      cols,
      rows,
      startedAt: new Date().toISOString(),
      restored,
      replay: '',
      subscribers: new Set(),
      exitSubscribers: new Set(),
    };
    // Raw history is only a fallback for PTYs that can't serialize their
    // screen (test fakes) — real sessions replay PtySession.serialize().
    const keepRaw = !pty.serialize;
    pty.setOutputHandler((data) => {
      if (keepRaw) {
        entry.replay += data;
        if (entry.replay.length > REPLAY_MAX) {
          entry.replay = entry.replay.slice(entry.replay.length - REPLAY_MAX);
        }
      }
      for (const cb of entry.subscribers) {
        try { cb(data); } catch { /* subscriber gone */ }
      }
    });
    pty.onExit = (code) => {
      for (const cb of entry.exitSubscribers) {
        try { cb(code); } catch { /* */ }
      }
      setTimeout(() => {
        // Only forget it if nothing respawned under the same id meanwhile.
        if (this.entries.get(id) === entry) {
          this.entries.delete(id);
          void this.persist();
        }
      }, FORGET_EXITED_MS).unref?.();
    };
    this.entries.set(id, entry);
    void this.persist();
    return this.info(entry);
  }

  write(id: string, data: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.pty.exited) return false;
    e.pty.write(data);
    return true;
  }

  /** Last writer wins — with several clients attached (browser + a real
   *  terminal) the one that most recently resized sets the grid, like
   *  tmux's `window-size latest`. */
  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e || e.pty.exited) return;
    if (cols < 2 || rows < 2 || (cols === e.cols && rows === e.rows)) return;
    e.cols = cols;
    e.rows = rows;
    e.pty.resize(cols, rows);
  }

  /** Attach a client: returns the screen snapshot plus a disposer. */
  attach(
    id: string,
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ): { replay: ReplaySnapshot; detach: () => void } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    e.subscribers.add(onData);
    e.exitSubscribers.add(onExit);
    return {
      replay: {
        data: e.pty.serialize?.() || e.replay,
        cols: e.cols,
        rows: e.rows,
      },
      detach: () => {
        e.subscribers.delete(onData);
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
    e.subscribers.clear();
    e.exitSubscribers.clear();
    const exited = e.pty.exited
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          e.pty.onExit = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    e.pty.dispose();
    await Promise.all([exited, this.persist()]);
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
      } catch {
        // One bad entry (tool missing, cwd unreadable) mustn't block the rest.
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
    };
  }

  private readPersisted(): PersistedFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf-8'));
      return raw && typeof raw === 'object' ? (raw as PersistedFile) : {};
    } catch {
      return {};
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedFile = {};
    // Exited entries still lingering (see FORGET_EXITED_MS) are kept on
    // purpose — dropping them on an unrelated write would defeat the delay.
    for (const e of this.entries.values()) {
      snapshot[e.id] = { ...e.spec, startedAt: e.startedAt };
    }
    const content = JSON.stringify(snapshot, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        ensureFile(this.sessionsPath, '{}');
        await withFileLock(this.sessionsPath, () => {
          atomicWriteFile(this.sessionsPath, content);
        });
      })
      .catch(() => { /* best-effort — next change retries */ });
    return this.writeChain;
  }
}
