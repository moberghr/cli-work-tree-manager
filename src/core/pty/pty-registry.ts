import fs from 'node:fs';
import { agentById, sessionToolFor } from '../agents/index.js';
import type { AiToolSpec } from '../platform/ai-launcher.js';
import { ASSISTANT_ID } from '../agents/assistant.js';
import { isAccountLoginId } from './account-login-id.js';
import { loadConfig } from '../platform/config.js';
import { PtySession } from './pty-session.js';
import { atomicWriteFile, ensureFile, withFileLockSync } from '../platform/fs-safe.js';
import { dbPtySessions, type PtySessionsStore } from './pty-sessions-file.js';
import { applyEnvDelta, hasEnvDelta, type EnvDelta } from '../platform/env-delta.js';
import { isPersistedPty, keepEnv, type PersistedPty, type PersistedPtys, type PtyInfo, type SpawnSpec } from './pty-host-protocol.js';
import { logSwallowed, swallow } from '../platform/best-effort.js';
import { report } from '../platform/report.js';
import { TerminalColors } from './terminal-colors.js';
import type { ReplyPart } from './terminal-replies.js';
import { OutputPacer, realTimers, type PacerTimers, type PtyFlow } from './output-pacer.js';
import type { SnapshotOptions } from './screen-mirror.js';
import { MIN_ROWS, validGrid, type Grid, type WindowsPty } from './terminal-size.js';

const REPLAY_MAX = 256 * 1024;

/**
 * A halted agent that no `resume` reaches in this long is started again on its old spec (work web died between the two).
 * Minutes, not seconds: a switch of account moves its conversation folders in between, and a big one across volumes takes
 * a while; the switch then restarts it in place on the new account (`not-halted` → restart, pty-pool.ts).
 */
export const HALT_RESUME_MS = 5 * 60_000;

/** How long an exited PTY lingers before it's dropped from the persisted
 *  list. During a Windows shutdown/logoff the child Claudes are often killed
 *  a moment BEFORE the host; dropping them immediately would erase exactly
 *  the list we need to restore after the reboot. A host that's itself about
 *  to die never reaches the timer. */
const FORGET_EXITED_MS = 5_000;

/** The grid a PTY starts at when nothing says another: no client stated one, and none has set one since the host started. */
export const DEFAULT_GRID: Grid = { cols: 120, rows: 32 };

/**
 * How long `redraw` holds the PTY one row smaller before it puts it back. A same-size SIGWINCH repaints nothing in a
 * Node or Bun agent (Claude Code is a Bun binary): their `'resize'` event fires only when the size they read changed,
 * and they read it when they get to the signal. Measured (node-pty 1.1, Node 24 and Bun 1.3): the two resizes back to
 * back gave two SIGWINCHes and no `'resize'`; 30 ms apart gave both. 100 ms leaves a busy agent's event loop time.
 */
export const REDRAW_JIGGLE_MS = 100;

/** A grid a client set is written to the restore list this long after the last change (a drag resizes many times). */
const GRID_PERSIST_MS = 1000;

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
  serialize?(opts?: SnapshotOptions): string;
  /** The serialized screen once everything written so far is parsed (see
   *  PtySession.serializeSettled). Optional: a fake's screen is its raw buffer. */
  serializeSettled?(opts?: SnapshotOptions): Promise<string>;
  /** Visible screen as plain text (PtySession.screenText). */
  screenText?(): string;
  /** Its screen's copy answers the agent's queries in output arriving while `now()` says so (PtySession.answerQueries).
   *  Optional: a fake has no screen to answer from. */
  answerQueries?(now: () => boolean, colors: Pick<TerminalColors, 'reply'>): void;
  /** Stop and start reading its output, for a client to catch up (PtySession.pause). Optional: where it can't, nothing waits. */
  pause?(): void;
  resume?(): void;
  /** The ConPTY it runs on (PtySession.windowsPty: the bundled one reflows as a newer Windows). Optional: the host's is said. */
  readonly windowsPty?: WindowsPty;
}

/** How a client attaches (`attach`). */
export interface AttachOptions {
  /** It acks what it draws (`?flow=1`, flow-control.ts): it is paced. Else it is sent everything, as before. */
  metered?: boolean;
  /** It fell behind and caught up: the screen as it stands now, before live output again (the host's `replay` frame). */
  onReplay?: (replay: ReplaySnapshot) => void;
  /**
   * Its catch-up screens are the screen only, without the scrollback (`?catchup=screen`: `work attach`, whose native
   * terminal keeps its own history). Its first screen still has the scrollback.
   */
  screenOnlyCatchUp?: boolean;
  /**
   * Its grid, stated as it attaches (`?cols=…&rows=…`, terminal-size.ts): it takes the PTY's size, as its first resize
   * would have — the terminal shown or `work attach`, never a hidden one. The PTY and its screen are resized to it
   * BEFORE the snapshot is taken, so the snapshot is drawn for its grid and it needs no second reflow; the agent's
   * repaint for it follows as live output.
   */
  grid?: Grid;
}

/** What a newly attached client is sent first: the screen as it stands,
 *  plus the grid it was drawn for. */
export interface ReplaySnapshot {
  data: string;
  cols: number;
  rows: number;
  /** The PTY is ConPTY's (a host on Windows): the client's xterm.js sets this, so it doesn't reflow lines ConPTY reflows. */
  windowsPty?: WindowsPty;
}

/** An environment without its unset names, typed as the spawn takes it. */
const definedEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));

export type PtySpawner = (spec: SpawnSpec & { resume: boolean }) => PtyLike;

export const defaultSpawner: PtySpawner = (spec) =>
  new PtySession(spec.cwd, spec.cols ?? DEFAULT_GRID.cols, spec.rows ?? DEFAULT_GRID.rows, undefined, {
    tool: spec.tool,
    resume: spec.resume,
    port: spec.port,
    initialPrompt: spec.initialPrompt,
    env: spec.env,
  });

/** The grid most of `grids` are (the first of those tied), or null when none is a grid. */
function mostCommonGrid(grids: Array<Grid | null>): Grid | null {
  const counts = new Map<string, { grid: Grid; n: number }>();
  for (const g of grids) {
    if (!g) continue;
    const key = `${g.cols}x${g.rows}`;
    const c = counts.get(key) ?? { grid: g, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  let best: { grid: Grid; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.grid ?? null;
}

/** An attached client, as its subscription to the output. */
type Client = (data: string) => void;

/** What pauses the PTY's output, if it can be paused. */
const flowOf = (pty: PtyLike): PtyFlow | null =>
  pty.pause && pty.resume ? { pause: () => pty.pause?.(), resume: () => pty.resume?.() } : null;

interface Entry {
  id: string;
  spec: Omit<PersistedPty, 'startedAt'>;
  pty: PtyLike;
  cols: number;
  rows: number;
  startedAt: string;
  restored: boolean;
  replay: string;
  /** The attached clients, the first attached first. */
  subscribers: Set<Client>;
  exitSubscribers: Set<(code: number) => void>;
  /** The client used last — typed in or resized (`lead`); the PTY has its size. Null: none since, or it left. */
  leader: Client | null;
  /** Who answers the queries in the output that arrived last (`designate`): its answers go through, the others' don't. */
  answerer: Client | null;
  /** Its output on its way to the clients: coalesced into frames, paced by their acks (output-pacer.ts). */
  pacer: OutputPacer<Client>;
  /** Set once the process exited (the entry lingers FORGET_EXITED_MS). */
  exitCode: number | null;
  /** When it last printed anything (ms): an idle Claude at its prompt prints nothing. */
  lastOutputAt: number;
  /** Its agent is being restarted (restart): the old process's end isn't the session's, a spawn starts no
   *  second one, and a second restart gets this one's outcome. */
  restarting?: Promise<PtyInfo | null>;
  /** Its agent was stopped by `halt` and isn't started again yet: the entry, its record and its clients stay; `timer` starts it
   *  again on its old spec if no `resume` comes. */
  halted?: { timer: ReturnType<typeof setTimeout> };
  /** The environment it was started with, in memory only (never in the restore list: it can hold secrets), so a
   *  restart runs as the session did; a restore after the host restarts has only what `hostEnv` kept. */
  env?: Record<string, string>;
  /** A `redraw` under way: the timer that puts the grid back. */
  redrawing?: unknown;
}

export interface RegistryDeps {
  /** The env variable names to keep for a restore (default: config `hostEnv`). */
  keepEnvNames?: () => string[];
  spawner?: PtySpawner;
  /** Its agent can resume a conversation in this folder, with the environment it will start with (default: the agent's own check, agents/). */
  hasConversation?: (cwd: string, tool: string, env?: Readonly<Record<string, string | undefined>>) => boolean;
  /** Where the restore list lives. Default: state.db. */
  sessions?: PtySessionsStore;
  /** Keep the restore list in this JSON file instead (tests, which must
   *  never touch the user's state.db). */
  sessionsPath?: string;
  cwdExists?: (cwd: string) => boolean;
  /** The tool as it is started (default: its agent's `sessionTool`, which gives a Claude work's hooks). */
  sessionTool?: (tool: AiToolSpec) => AiToolSpec;
  /** The output pacer's clock (tests). */
  timers?: PacerTimers;
  /** The `windowsPty` its clients are told with each screen (terminal-size.ts). None by default: the PTY host sets it
   *  from its platform and Windows build (pty-host.ts), so a registry in a test says the same on every platform. */
  windowsPty?: WindowsPty | null;
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
  private readonly hasConversation: (cwd: string, tool: string, env?: Readonly<Record<string, string | undefined>>) => boolean;
  private readonly store: PtySessionsStore;
  private readonly cwdExists: (cwd: string) => boolean;
  private readonly keepEnvNames: () => string[];
  private readonly sessionTool: (tool: AiToolSpec) => AiToolSpec;
  private readonly timers?: PacerTimers;
  private readonly windowsPty?: WindowsPty;
  /**
   * The last grid a client set (a resize, an attach or a start that stated one): what a PTY started with no grid of its
   * own (a background start, a session's Start) starts at. After a host restart, before any client: the restored
   * sessions' most common grid. In memory; each session's own grid is in the restore list.
   */
  private lastGrid: Grid | null = null;
  /** The restore-list write a grid change is waiting for (GRID_PERSIST_MS). */
  private gridPersist: unknown = null;
  /** Serializes persistence writes inside this process. */
  private writeChain: Promise<void> = Promise.resolve();
  /** The colours the host answers a colour query with itself: the last a terminal attached to any PTY answered with. */
  readonly colors = new TerminalColors();

  constructor(deps: RegistryDeps = {}) {
    this.spawner = deps.spawner ?? defaultSpawner;
    this.hasConversation = deps.hasConversation ?? ((cwd, tool, env) => agentById(tool).launch.canResume(cwd, { env }));
    this.store = deps.sessions ?? (deps.sessionsPath ? fileSessionsStore(deps.sessionsPath) : dbPtySessions);
    this.cwdExists = deps.cwdExists ?? ((p) => fs.existsSync(p));
    this.keepEnvNames = deps.keepEnvNames ?? (() => loadConfig()?.hostEnv ?? []);
    this.sessionTool = deps.sessionTool ?? sessionToolFor;
    this.timers = deps.timers;
    if (deps.windowsPty) this.windowsPty = deps.windowsPty;
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
    if (existing && (!existing.pty.exited || existing.restarting || existing.halted)) return this.info(existing);
    // A restore entry (or an older client) from before --unsafe was retired may carry `unsafe: true` and its tool an
    // `unsafeFlag`: neither is started with, nor written back — the entry this host records says it starts normally,
    // which is what lifts the one-release guards (sessions/legacy-unsafe.ts). REMOVE the strip with them next release.
    const { unsafeFlag: _retired, ...tool } = spec.tool as typeof spec.tool & { unsafeFlag?: unknown };
    // Started — and recorded for a restore — with work's hooks for this process (`--settings`, a restore entry from
    // before gets it too), never the user's settings' (agents/session-hooks.ts).
    spec = { ...spec, tool: this.sessionTool(tool) };

    // A spawn from a shell keeps the variables config `hostEnv` names; a
    // restore — or a respawn without a shell (the Terminal tab) — runs with
    // the host's environment plus what its session kept.
    // What is kept is the environment as the agent will see it: the session's account (`agentEnv`) applied first, so a
    // default session never keeps the launching shell's CLAUDE_CONFIG_DIR, and a named one always keeps its own.
    const agentEnv = hasEnvDelta(spec.agentEnv) ? spec.agentEnv : undefined;
    const kept = spec.env
      ? keepEnv(definedEnv(applyEnvDelta(spec.env, agentEnv)), this.keepEnvNames())
      : (spec.keptEnv ?? existing?.spec.keptEnv);
    const env = this.launchEnv({ env: spec.env, keptEnv: kept, agentEnv });
    if (env) spec = { ...spec, env };

    // The grid it starts at: the one stated (a tab's, `work attach`'s terminal's, a restore's own), else the last one a
    // client set, else the default. Started at one and resized a moment later, an agent paints twice.
    const stated = validGrid(spec.cols, spec.rows);
    const { cols, rows } = stated ?? this.lastGrid ?? DEFAULT_GRID;
    if (stated && !restored) this.lastGrid = stated;
    const pty = this.spawner({
      ...spec,
      cols,
      rows,
      // `--continue` hard-errors in a directory Claude never ran in;
      // `--fresh` opts out even when one exists.
      resume: !spec.fresh && this.hasConversation(spec.cwd, spec.tool.cmd, spec.env ?? process.env),
    });
    // The one that holds the PTY (may pause it) is the one that answers the agent: the client used last, else the first attached.
    const pacer = new OutputPacer<Client>({ flow: null, holder: () => this.pick(entry), timers: this.timers });
    const entry: Entry = {
      id,
      // Only what a restore may reuse: env/prompt/fresh are one-shot (and
      // env can hold secrets), so they never reach pty-sessions.json — but
      // the variables config `hostEnv` names do (keepEnv), so a restore after
      // a reboot gets the JAVA_HOME / PATH it was started with.
      spec: {
        cwd: spec.cwd,
        tool: spec.tool,
        port: spec.port,
        ...(kept ? { keptEnv: kept } : {}),
        ...(agentEnv ? { agentEnv } : {}),
      },
      env: spec.env as Record<string, string> | undefined,
      pty,
      cols,
      rows,
      startedAt: new Date().toISOString(),
      restored,
      replay: '',
      subscribers: new Set(),
      exitSubscribers: new Set(),
      leader: null,
      answerer: null,
      pacer,
      exitCode: null,
      lastOutputAt: Date.now(),
    };
    this.wire(entry, pty);
    this.entries.set(id, entry);
    void this.persist();
    return this.info(entry);
  }

  /**
   * The env a spawn runs with: the shell's when it came from one; else the host's plus what its session kept; then the
   * session's account change (`agentEnv`) over it — on the host's own environment when there is nothing else, so a
   * default session never inherits a CLAUDE_CONFIG_DIR the host was started with. Undefined: no change, the host's own env.
   */
  private launchEnv(spec: {
    env?: Record<string, string>;
    keptEnv?: Record<string, string>;
    agentEnv?: EnvDelta;
  }): Record<string, string> | undefined {
    const base = spec.env ?? (spec.keptEnv ? { ...(process.env as Record<string, string>), ...spec.keptEnv } : undefined);
    return hasEnvDelta(spec.agentEnv) ? definedEnv(applyEnvDelta(base ?? process.env, spec.agentEnv)) : base;
  }

  /** `pty` becomes the entry's process: its output to the entry's clients, its exit told to them (then forgotten). */
  private wire(entry: Entry, pty: PtyLike): void {
    const id = entry.id;
    entry.pty = pty;
    // Raw history is only a fallback for PTYs that can't serialize their
    // screen (test fakes) — real sessions replay PtySession.serialize().
    const keepRaw = !pty.serialize;
    entry.pacer.setFlow(flowOf(pty));
    // Asked as the output arrives (before its screen parses it): with no client attached, the screen's copy answers.
    pty.answerQueries?.(() => this.designate(entry) === null, this.colors);
    pty.setOutputHandler((data) => {
      this.designate(entry);
      entry.lastOutputAt = Date.now();
      if (keepRaw) {
        entry.replay += data;
        if (entry.replay.length > REPLAY_MAX) {
          entry.replay = entry.replay.slice(entry.replay.length - REPLAY_MAX);
        }
      }
      // To the clients now, or with what follows within a few ms (output-pacer.ts): who answers it is decided above, as it arrives.
      entry.pacer.output(data);
    });
    pty.onExit = (code) => {
      // Its last output before its end, and the final screen to a client that is behind (each told it ended after it).
      entry.pacer.end();
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

  /**
   * Who answers the agent's queries in the output arriving now: exactly one, decided as it arrives (terminal-rendering.md,
   * "Who answers a query"). The client used last (it typed or resized: it has the PTY's size), else the first attached;
   * null when none is attached — then the PTY's screen copy answers. Kept until the next output, so the answers to it
   * that come back from that client go through.
   */
  private designate(e: Entry): Client | null {
    const who = this.pick(e);
    e.answerer = who;
    return who;
  }

  /**
   * `designate`'s choice, without making it: among the clients sent live output (one behind is sent none, so it would
   * never see the query: output-pacer.ts), the one used last, else the first attached. Also the one that holds the
   * PTY (may pause it until it has drawn what it was sent).
   */
  private pick(e: Entry): Client | null {
    if (e.leader && e.subscribers.has(e.leader) && e.pacer.live(e.leader)) return e.leader;
    for (const c of e.subscribers) if (e.pacer.live(c)) return c;
    return null;
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
    const grid = validGrid(cols, rows);
    if (!grid || (cols === e.cols && rows === e.rows)) return;
    e.cols = cols;
    e.rows = rows;
    e.pty.resize(cols, rows);
    this.remember(grid);
  }

  /** `grid` is the last a client set: what a start with none takes, and — soon — the session's grid in the restore list. */
  private remember(grid: Grid): void {
    this.lastGrid = grid;
    if (this.gridPersist !== null) return;
    const timers = this.timers ?? realTimers;
    const handle = timers.set(() => {
      this.gridPersist = null;
      void this.persist();
    }, GRID_PERSIST_MS);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.gridPersist = handle;
  }

  /**
   * Ask its agent to draw its screen again (⋯ → Reconnect terminal: the screen looks wrong). The PTY is made one row
   * smaller and, REDRAW_JIGGLE_MS later, put back to the grid it has then: two real size changes, so the agent sees one
   * whatever it runs on. A same-size SIGWINCH (zmx's way) repaints nothing in a Node or Bun agent (REDRAW_JIGGLE_MS); on
   * Windows ConPTY sends no resize for an unchanged size at all. The clients aren't resized: the agent's repaint at the
   * smaller grid is drawn over by the one at theirs. False when nothing runs.
   */
  redraw(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.pty.exited || e.restarting || e.halted) return false;
    if (e.redrawing !== undefined) return true;
    e.pty.resize(e.cols, e.rows > MIN_ROWS ? e.rows - 1 : e.rows + 1);
    e.redrawing = (this.timers ?? realTimers).set(() => {
      e.redrawing = undefined;
      // Back to the grid it has now (a client may have set another meanwhile), unless it was killed or restarted.
      if (this.entries.get(id) === e && !e.pty.exited && !e.restarting && !e.halted) e.pty.resize(e.cols, e.rows);
    }, REDRAW_JIGGLE_MS);
    return true;
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
   *
   * `lead()`: this client was used (typed in, resized), so it answers the agent's queries from the next output on.
   * `replies(parts)`: what of what this client sent on its own goes to the agent — its focus and mouse-motion reports
   * always, its answers only if it answers the queries in the output that arrived last (`designate`).
   *
   * Output reaches it in frames (output-pacer.ts). `opts.metered`: it acks what it draws (`ack(chars)`); if it falls
   * behind, it is sent nothing until it catches up, then the screen as it stands then (`opts.onReplay`, taken and held
   * as the attach's is: nothing lost, nothing twice) and live output again. `offset`: the output offset its snapshot
   * stands at (where its first frame starts).
   */
  attach(
    id: string,
    onData: (data: string, end?: number) => void,
    onExit: (code: number) => void,
    opts: AttachOptions = {},
  ): {
    replay: ReplaySnapshot;
    ready: Promise<ReplaySnapshot>;
    start: () => void;
    detach: () => void;
    lead: () => void;
    replies: (parts: ReplyPart[]) => string;
    ack: (chars: number) => void;
    offset: number;
    exitedWith: number | null;
  } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    // Attaching to one that already exited (inside the linger window): its
    // exit subscribers have fired, so tell this client now — otherwise it
    // would sit on a dead screen, its input silently dropped.
    const exitedWith = e.pty.exited && !e.restarting && !e.halted ? (e.exitCode ?? 0) : null;
    // Mid-restart the process in the entry is the old one, already disposed (its screen with it): nothing of it to
    // send or wait on — the new one draws from scratch, straight to this client.
    const restarting = !!e.restarting || !!e.halted;
    const settled = restarting ? undefined : e.pty.serializeSettled;
    // Held output while the settled snapshot is taken; null = passed straight on.
    let held: Array<[string, number | undefined]> | null = settled ? [] : null;
    let started = !settled;
    let gone = false;
    const sub = (d: string, end?: number) => (held ? held.push([d, end]) : onData(d, end));
    // On Windows (the host says so), the ConPTY this PTY runs on: the bundled one reflows as a newer build than the OS's.
    const windowsPty = this.windowsPty ? (e.pty.windowsPty ?? this.windowsPty) : undefined;
    const snapshot = (data: string): ReplaySnapshot => ({
      data,
      cols: e.cols,
      rows: e.rows,
      ...(windowsPty ? { windowsPty } : {}),
    });
    // A screen being taken (its first, a catch-up): output held meanwhile, and the PTY's end, told after the screen.
    let catchingUp = false;
    let endedWith: number | null = null;
    const exitSub = (code: number) => {
      if (catchingUp || !started) endedWith = code;
      else onExit(code);
    };
    // It fell behind and caught up (output-pacer.ts): the screen as it stands now, the output from now on held until it is sent.
    const resync = () => {
      // Before its first screen nothing could have been acked; after it left, nobody to send it to.
      if (gone || !started) return;
      const shot: SnapshotOptions | undefined = opts.screenOnlyCatchUp ? { scrollback: false } : undefined;
      // Mid-restart the old process's screen is gone with it: an empty screen, the new one draws from scratch.
      const between = !!e.restarting || !!e.halted;
      const settle = between ? undefined : e.pty.serializeSettled;
      if (!settle) {
        opts.onReplay?.(snapshot(between ? '' : e.pty.serialize?.(shot) || e.replay));
        return;
      }
      const mine: Array<[string, number | undefined]> = [];
      held = mine;
      catchingUp = true;
      void settle
        .call(e.pty, shot)
        .catch(() => '')
        .then((data) => {
          if (gone || held !== mine) return;
          opts.onReplay?.(snapshot(data || e.replay));
          held = null;
          catchingUp = false;
          for (const [d, end] of mine) onData(d, end);
          if (endedWith !== null) onExit(endedWith);
        });
    };
    // Its first screen: taken where it joins the output (`join`), as a promise of it.
    let resolveReady: (r: ReplaySnapshot) => void = () => {};
    const ready = new Promise<ReplaySnapshot>((resolve) => (resolveReady = resolve));
    let offset = e.pacer.offset;
    /**
     * It joins the output here, and its first screen is taken here: what came before is on that screen, what comes after
     * is sent to it (the pacer sends what was pending to the others first). Between synchronized frames (whenNoFrame):
     * mid-frame, at the frame's end (or its cap) — the PTY's output is cut there (PtySession), so the screen is exactly
     * what came before, never one drawn halfway (a screen has no 2026 in it to hold the client's drawing).
     */
    const join = (entryGone: boolean) => {
      if (gone || entryGone || this.entries.get(id) !== e) {
        resolveReady(snapshot(''));
        return;
      }
      e.pacer.add(sub, { metered: !!opts.metered, send: sub, resync });
      offset = e.pacer.offset;
      if (settled) void settled.call(e.pty).then((d) => resolveReady(snapshot(d || e.replay)));
      else resolveReady(snapshot(restarting ? '' : e.pty.serialize?.() || e.replay));
    };
    if (exitedWith === null) {
      e.subscribers.add(sub);
      e.exitSubscribers.add(exitSub);
      // It stated its grid: it takes the size now, as its first resize would have (it is the one used last), and the
      // snapshot below is taken at that grid: the screen copy reflowed now, the agent's repaint for it (SIGWINCH)
      // following as live output, held for it like any other until `start()`.
      const grid = opts.grid ? validGrid(opts.grid.cols, opts.grid.rows) : null;
      if (grid) {
        e.leader = sub;
        e.pacer.used(sub);
        if (!restarting) this.resize(id, grid.cols, grid.rows);
        else {
          // Nothing runs to resize: the agent being started again starts at it (resumeEntry).
          e.cols = grid.cols;
          e.rows = grid.rows;
          this.remember(grid);
        }
      }
    }
    const replay = snapshot(restarting ? '' : e.pty.serialize?.() || e.replay);
    if (exitedWith !== null) resolveReady(replay);
    // After the resize: the screen copy applies it in order with the output before it (ScreenMirror.resize), and the
    // screen is taken behind both.
    else e.pacer.whenNoFrame(join);
    return {
      exitedWith,
      replay,
      get offset() {
        return offset;
      },
      ready,
      start: () => {
        const q = held;
        held = null;
        started = true;
        for (const [d, end] of q ?? []) onData(d, end);
        // It ended while its first screen was being taken: told after that screen and the output before its end.
        if (endedWith !== null && !catchingUp) {
          const code = endedWith;
          endedWith = null;
          onExit(code);
        }
      },
      detach: () => {
        gone = true;
        e.subscribers.delete(sub);
        e.exitSubscribers.delete(exitSub);
        if (e.leader === sub) e.leader = null;
        // It left before answering, maybe: the next in line answers what it was sent (it was sent the same).
        if (e.answerer === sub) this.designate(e);
        // Holding the PTY paused, maybe: the next in line holds it, or nobody does and it reads on.
        e.pacer.remove(sub);
      },
      lead: () => {
        e.leader = sub;
        e.pacer.used(sub);
      },
      ack: (chars) => e.pacer.ack(sub, chars),
      replies: (parts) => {
        const answers = e.answerer === sub;
        let out = '';
        for (const part of parts) {
          if (!part.answer) out += part.text;
          else if (answers) {
            out += part.text;
            this.colors.remember(part.text);
          }
        }
        return out;
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
    if (e.halted) clearTimeout(e.halted.timer);
    // The terminals attached to it are told it ended (and so offer Enter to start it again):
    // dropped silently, a dashboard tab kept a connection to nothing and took no input.
    const attached = [...e.exitSubscribers];
    e.subscribers.clear();
    e.exitSubscribers.clear();
    e.pacer.dispose();
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
   *
   * `agentEnv`: the agent's environment for the new process differs from the old one's by this (a session moved to
   * another account): it replaces the entry's own, in the restore list too — the process is started on what the
   * session is now, not on what it was.
   */
  restart(id: string, timeoutMs = 3000, agentEnv?: EnvDelta): Promise<PtyInfo | null> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(null);
    // Asked twice (two windows, the CLI): both get the one restart's outcome, failure included.
    if (e.restarting) return e.restarting;
    if (e.halted) return Promise.reject(new Error('its agent is halted: resume it first'));
    if (e.pty.exited) return Promise.resolve(null);
    const running = this.haltEntry(e, timeoutMs)
      .then((ok) => (ok ? this.resumeEntry(e, agentEnv) : this.get(e.id)))
      .finally(() => {
        e.restarting = undefined;
      });
    e.restarting = running;
    return running;
  }

  /**
   * Its agent stopped, and kept stopped until `resume` (a switch of account moves its conversation files in between,
   * which a running — or just exiting — agent would write into again). The entry, its restore-list record and the
   * attached clients stay, and none is told it ended. Refused while it is being restarted or already halted; an agent that
   * doesn't stop within `timeoutMs` ends the session as `restart` does. A `resume` that never comes (work web died)
   * can't leave the session dead: after `resumeAfterMs` it is started again on its old spec. Null: nothing runs.
   */
  halt(id: string, timeoutMs = 3000, resumeAfterMs = HALT_RESUME_MS): Promise<PtyInfo | null> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(null);
    if (e.restarting || e.halted) return Promise.reject(new Error('its agent is already being restarted or halted'));
    if (e.pty.exited) return Promise.resolve(null);
    const running = this.haltEntry(e, timeoutMs)
      .then((ok) => {
        if (!ok) return this.get(id); // killed meanwhile
        const timer = setTimeout(() => {
          report('warn', `${id}: halted, and no resume within ${Math.round(resumeAfterMs / 1000)} s: starting it again on its old spec`);
          this.resume(id).catch(swallow(`resume halted ${id}`));
        }, resumeAfterMs);
        timer.unref?.();
        e.halted = { timer };
        return this.info(e);
      })
      .finally(() => {
        e.restarting = undefined;
      });
    e.restarting = running;
    return running;
  }

  /**
   * Start a halted agent again in place, resuming its conversation, on `agentEnv` when given (as `restart` takes it): the
   * clients carry on. Null when it isn't halted.
   */
  resume(id: string, agentEnv?: EnvDelta): Promise<PtyInfo | null> {
    const e = this.entries.get(id);
    if (!e?.halted) return Promise.resolve(null);
    clearTimeout(e.halted.timer);
    e.halted = undefined;
    const running = this.resumeEntry(e, agentEnv).finally(() => {
      e.restarting = undefined;
    });
    e.restarting = running;
    return running;
  }

  /** Stop the entry's process and wait for it to exit (timeoutMs); one that won't ends the session and throws. False: it was killed meanwhile. */
  private async haltEntry(e: Entry, timeoutMs: number): Promise<boolean> {
    const id = e.id;
    const old = e.pty;
    // Its last output to the clients, and no pause left on a process that is going.
    e.pacer.flush();
    e.pacer.setFlow(null);
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      old.onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      old.dispose();
    });
    if (this.entries.get(id) !== e) return false; // killed meanwhile
    if (!stopped) {
      // Its screen is gone with the dispose and the kill is on its way: not a session to keep showing (frozen
      // terminals, input into a dying process). Ended as a stop is, and no second agent is started on its
      // conversation while the old one may still be going.
      await this.endEntry(e);
      throw new Error(
        `its agent didn't stop within ${Math.round(timeoutMs / 1000)} s; its session was stopped (open it to start it again)`,
      );
    }
    return true;
  }

  /** Start the entry's agent again in place (its process is gone): `--continue`, on `agentEnv` when given. */
  private async resumeEntry(e: Entry, agentEnv?: EnvDelta): Promise<PtyInfo | null> {
    if (this.entries.get(e.id) !== e) return this.get(e.id); // killed meanwhile
    if (agentEnv) this.useAgentEnv(e, agentEnv);
    // Its hooks as this build gives them (an entry started by an older host had none of its own).
    e.spec = { ...e.spec, tool: this.sessionTool(e.spec.tool) };
    let pty: PtyLike;
    try {
      const env = e.env ?? this.launchEnv(e.spec);
      pty = this.spawner({
        ...e.spec,
        env,
        cols: e.cols,
        rows: e.rows,
        resume: this.hasConversation(e.spec.cwd, e.spec.tool.cmd, env ?? process.env),
      });
    } catch (err) {
      await this.endEntry(e); // nothing runs now
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

  /** The entry's agent environment becomes `delta`: in its spec (the restore list), the variables it kept, and the environment it started with. */
  private useAgentEnv(e: Entry, delta: EnvDelta): void {
    const { agentEnv: _old, keptEnv, ...rest } = e.spec;
    const kept = keptEnv ? definedEnv(applyEnvDelta(keptEnv, delta)) : undefined;
    e.spec = {
      ...rest,
      ...(kept && Object.keys(kept).length ? { keptEnv: kept } : {}),
      ...(hasEnvDelta(delta) ? { agentEnv: delta } : {}),
    };
    if (e.env) e.env = definedEnv(applyEnvDelta(e.env, delta));
  }

  /** A restart that can't go on ends the session as a kill does: its terminals told (they offer Enter to start it again), forgotten. */
  private async endEntry(e: Entry): Promise<void> {
    if (e.halted) clearTimeout(e.halted.timer);
    if (this.entries.get(e.id) === e) this.entries.delete(e.id);
    const attached = [...e.exitSubscribers];
    e.subscribers.clear();
    e.exitSubscribers.clear();
    e.pacer.dispose();
    await this.persist();
    for (const cb of attached) {
      try {
        cb(1);
      } catch {
        /* that client is gone */
      }
    }
  }

  /**
   * Respawn everything in the persisted list. Called once at host startup.
   * Worktrees that no longer exist are dropped, and so is the Ctrl+K
   * assistant: it starts when you open it (its conversation resumes then) —
   * restored, one opened once ran for good, a Claude nobody used. Nor is an
   * account's login terminal (account-login.ts): it is the Accounts page's,
   * for as long as its panel is open.
   */
  async restore(): Promise<string[]> {
    const saved = this.readPersisted();
    const restored: string[] = [];
    for (const [id, entry] of Object.entries(saved)) {
      if (id === ASSISTANT_ID || isAccountLoginId(id) || !this.cwdExists(entry.cwd)) continue;
      try {
        this.spawn(id, entry, true);
        restored.push(id);
      } catch (err) {
        // One bad entry (tool missing, cwd unreadable) mustn't block the rest.
        logSwallowed(`restore session ${id} in ${entry.cwd}`, err);
      }
    }
    // No client has set a grid yet: a start with none takes the one most of the restored sessions had.
    this.lastGrid ??= mostCommonGrid(restored.map((id) => validGrid(saved[id].cols, saved[id].rows)));
    await this.persist();
    return restored;
  }

  /** Host shutdown: kill every PTY but KEEP the persisted list, so the next
   *  host start restores them. */
  disposeAllKeepingState(): void {
    // A grid write still to come would write the list with nothing in it.
    if (this.gridPersist !== null) (this.timers ?? realTimers).clear(this.gridPersist);
    this.gridPersist = null;
    for (const e of this.entries.values()) {
      e.pty.onExit = undefined;
      e.subscribers.clear();
      e.exitSubscribers.clear();
      e.pacer.dispose();
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
      // Its grid too: a restore after a reboot starts it at the size it was used at last.
      snapshot[e.id] = { ...e.spec, cols: e.cols, rows: e.rows, startedAt: e.startedAt };
    }
    this.writeChain = this.writeChain
      .then(() => this.store.write(snapshot))
      .catch(swallow('persist the PTY restore list (next change retries)'));
    return this.writeChain;
  }
}
