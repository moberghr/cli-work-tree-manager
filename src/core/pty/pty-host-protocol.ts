import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import type { AiToolSpec } from '../platform/ai-launcher.js';
import { isEnvDelta, type EnvDelta } from '../platform/env-delta.js';
import type { WindowsPty } from './terminal-size.js';
import type { StreamSignal } from './stream-status.js';

/**
 * Wire contract between the PTY host (`work pty-host`, the long-lived
 * process that owns every Claude PTY) and its clients (`work web`,
 * `work attach`). Bump PROTOCOL_VERSION on any incompatible change: a
 * client that finds an older host running tells the user to restart it
 * (`work pty-host --restart`) instead of silently misbehaving — the host
 * outlives rebuilds by design.
 *
 * 2: the restore list moved from pty-sessions.json into state.db. A v1 host
 *    still writes the file, which a v2 host adopts on start
 *    (adoptLegacyRestoreList).
 */
export const PROTOCOL_VERSION = 2;

/**
 * What this host can do beyond PROTOCOL_VERSION, answered by `/health` (additive: a host from before answers none).
 * `agentEnv`: it applies a spawn's / restart's / resume's `agentEnv` (a session's Claude account); `halt`: halt / resume.
 * A client asks before sending something an older host would silently drop (pty-pool.ts).
 */
export const HOST_FEATURES = ['agentEnv', 'halt', 'tickets'] as const;
export type HostFeature = (typeof HOST_FEATURES)[number];

/** Discovery file: where the running host listens and its auth token. */
export interface HostInfo {
  pid: number;
  port: number;
  token: string;
  version: number;
}

/** What a client asks the host to spawn. The host decides `--continue`
 *  itself (see `hasClaudeConversation`) so restores after a reboot make
 *  the same call a fresh spawn would. */
export interface SpawnSpec {
  cwd: string;
  tool: AiToolSpec;
  port?: number;
  /**
   * The grid to start at: the terminal it is started for (a Terminal tab's, `work attach`'s), or the one it was used at
   * last (a restore). None: the last grid a client set in this host, else 120 × 32 (pty-registry.ts). Persisted with
   * each restore-list entry (additive: a host from before writes none and starts a restore at 120 × 32).
   */
  cols?: number;
  rows?: number;
  // No `unsafe` any more: every agent starts in its own permission mode. An older client may still send
  // `unsafe: true`, and a restore list written by an older host may hold it (and its tool an `unsafeFlag`): extra
  // fields, so no PROTOCOL_VERSION bump. A current host starts nothing from them and drops both when it restores or
  // restarts a session (pty-registry.ts); for one release legacy-unsafe.ts reads an entry's `unsafe: true` as "an
  // older host still runs this agent without permission prompts" and keeps its guards (REMOVE IN THE NEXT RELEASE).
  /** `--fresh`: start a new conversation even if one exists. First spawn
   *  only — a restore always continues. */
  fresh?: boolean;
  /** `--prompt` / `--prompt-file` contents. First spawn only. */
  initialPrompt?: string;
  /** The launching shell's environment. First spawn only and never
   *  persisted — it can hold secrets; a restore after reboot uses the
   *  host's own environment. */
  env?: Record<string, string>;
  /**
   * What the agent's environment differs by for this session (its account's `CLAUDE_CONFIG_DIR`: set, or `null` = taken
   * out), applied over whatever environment the process starts with — the shell's, or the host's own. Persisted (a
   * folder path is no secret), so a restore keeps it. Additive, no PROTOCOL_VERSION bump: a host from before ignores
   * it and starts the agent on the environment it inherits (`work pty-host --restart` after upgrading).
   */
  agentEnv?: EnvDelta;
}

/** One entry of the host's restore list: how to respawn a session. The
 *  spec as launched, minus `env` (never persisted: it can hold secrets) —
 *  except the variables config `hostEnv` names (`keptEnv`), which a restore
 *  after a reboot puts back over the host's own environment. */
export interface PersistedPty extends SpawnSpec {
  startedAt: string;
  keptEnv?: Record<string, string>;
}

/** Names that look like secrets (or carry them, as a connection string does): never kept on disk, whatever `hostEnv` says. */
const SECRET_NAME =
  /TOKEN|SECRET|PASS|PWD|CREDENTIAL|PRIVATE|KEY|AUTH|BEARER|COOKIE|SESSION|CERT|SIGN|SALT|(^|_)PAT($|_)|DSN|CONN|DATABASE_URL|_URI$|_URL$/i;
/** Values that carry a password whatever their name: `scheme://user:pass@host`. */
const SECRET_VALUE = /:\/\/[^/\s:@]+:[^/\s@]+@/;

/** Always kept for a restore, whatever `hostEnv` says: the agent's account folder (a path, not a secret — SECRET_VALUE still applies). */
export const ALWAYS_KEPT_ENV = ['CLAUDE_CONFIG_DIR'] as const;

/** The variables of `env` to keep for a restore: the ones named (and `ALWAYS_KEPT_ENV`), that exist, and look like neither a secret nor a URL with a password in it. Pure. */
export function keepEnv(env: Record<string, string> | undefined, names: readonly string[]): Record<string, string> | undefined {
  if (!env) return undefined;
  const kept = Object.fromEntries(
    [...new Set([...names, ...ALWAYS_KEPT_ENV])]
      .filter((n) => !SECRET_NAME.test(n) && typeof env[n] === 'string' && !SECRET_VALUE.test(env[n]))
      .map((n) => [n, env[n]]),
  );
  return Object.keys(kept).length ? kept : undefined;
}
export type PersistedPtys = Record<string, PersistedPty>;

/** Shape check for a restore-list entry read back from storage. */
export function isPersistedPty(x: unknown): x is PersistedPty {
  const e = x as PersistedPty | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.cwd === 'string' &&
    !!e.tool &&
    typeof e.tool === 'object' &&
    (e.agentEnv === undefined || isEnvDelta(e.agentEnv)) &&
    (e.keptEnv === undefined ||
      (!!e.keptEnv && typeof e.keptEnv === 'object' && Object.values(e.keptEnv).every((v) => typeof v === 'string')))
  );
}

export interface PtyInfo {
  id: string;
  cwd: string;
  pid: number;
  exited: boolean;
  cols: number;
  rows: number;
  startedAt: string;
  /** Respawned by the host on startup from the persisted session list
   *  (after a crash, `--restart` or reboot), not by a client. */
  restored: boolean;
  /** Clients attached right now (dashboard Terminal tabs, `work attach`).
   *  Additive: a host from before it sends none. */
  clients?: number;
  /** When the PTY last printed anything (ISO). Additive, like clients. */
  lastOutputAt?: string;
  /** The tool's binary (`claude`, `opencode`…). Additive, like clients. */
  tool?: string;
  /** What its agent says about itself in its output: OSC 7501 program status, else OSC 9;4 progress (stream-status.ts).
   *  Absent when it says nothing, and from a host from before. Additive, like clients. */
  signal?: StreamSignal;
}

/** Client → host frames on the attach WebSocket (text, JSON). Host →
 *  client PTY output is sent as binary frames; control frames as text.
 *  `ack`: from a client that attached with `?flow=1` (flow-control.ts), the characters of output it finished drawing
 *  since its last ack. Additive, no PROTOCOL_VERSION bump: an older host ignores the parameter and the frame. */
export type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; chars: number }
  /** ⋯ → Reconnect terminal, after its replay: ask the agent to draw its screen again (registry.redraw). Additive: an older host drops it. */
  | { type: 'redraw' };

export type HostControlFrame =
  /** Sent first on attach: the serialized screen and the grid it was
   *  drawn for. Clients draw it at exactly cols×rows, then resize to their
   *  own size (which makes Claude redraw), and only then send input. A client
   *  that stated its grid as it attached (terminal-size.ts) is sent it at that
   *  grid already: its resize after it changes nothing.
   *  A client that acks is sent one again mid-session when it fell behind and caught up (output-pacer.ts): it resets
   *  its screen (scrollback too) and draws it, and nothing else — no resize, no focus, no input held for it. */
  | {
      type: 'replay';
      data: string;
      cols: number;
      rows: number;
      /** The host runs on Windows: its PTYs are ConPTY's, which reflows lines itself (terminal-size.ts). Additive. */
      windowsPty?: WindowsPty;
    }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

export function hostInfoPath(): string {
  return path.join(getConfigDir(), 'pty-host.json');
}

/** Held by a starting host from "is one running?" through writing its
 *  discovery file AND restoring the saved sessions — so two hosts can't
 *  both start, and a `work remove` racing a start waits for the restore
 *  instead of slipping between it (see stopSessionPty). */
export function hostStartLockPath(): string {
  return path.join(getConfigDir(), 'pty-host.start.lock');
}

/** The pre-SQLite restore list. Only the one-time import reads it now. */
export function ptySessionsPath(): string {
  return path.join(getConfigDir(), 'pty-sessions.json');
}

export function readHostInfo(): HostInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(hostInfoPath(), 'utf-8')) as HostInfo;
    if (typeof raw.port === 'number' && typeof raw.token === 'string' && typeof raw.pid === 'number') {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
