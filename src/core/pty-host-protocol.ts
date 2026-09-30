import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import type { AiToolSpec } from './ai-launcher.js';

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
  cols?: number;
  rows?: number;
  /** `--unsafe`: the tool's skip-permissions flag. Persisted, so a restore
   *  comes back with the same permission mode. */
  unsafe?: boolean;
  /** `--fresh`: start a new conversation even if one exists. First spawn
   *  only — a restore always continues. */
  fresh?: boolean;
  /** `--prompt` / `--prompt-file` contents. First spawn only. */
  initialPrompt?: string;
  /** The launching shell's environment. First spawn only and never
   *  persisted — it can hold secrets; a restore after reboot uses the
   *  host's own environment. */
  env?: Record<string, string>;
}

/** One entry of the host's restore list: how to respawn a session. The
 *  spec as launched, minus `env` (never persisted: it can hold secrets). */
export interface PersistedPty extends SpawnSpec {
  startedAt: string;
}
export type PersistedPtys = Record<string, PersistedPty>;

/** Shape check for a restore-list entry read back from storage. */
export function isPersistedPty(x: unknown): x is PersistedPty {
  const e = x as PersistedPty | null;
  return !!e && typeof e === 'object' && typeof e.cwd === 'string' && !!e.tool && typeof e.tool === 'object';
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
}

/** Client → host frames on the attach WebSocket (text, JSON). Host →
 *  client PTY output is sent as binary frames; control frames as text. */
export type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type HostControlFrame =
  /** Sent once, first, on attach: the serialized screen and the grid it was
   *  drawn for. Clients draw it at exactly cols×rows, then resize to their
   *  own size (which makes Claude redraw), and only then send input. */
  | { type: 'replay'; data: string; cols: number; rows: number }
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
    if (
      typeof raw.port === 'number' &&
      typeof raw.token === 'string' &&
      typeof raw.pid === 'number'
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
