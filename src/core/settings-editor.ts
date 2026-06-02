/**
 * Atomic read/edit/write helpers for `~/.claude/settings.json` — the user's
 * global Claude Code settings.
 *
 * Both `HookServer` (http-type hooks) and `installCommandHook` (command-type
 * hooks) mutate this file at startup/shutdown. They previously each had
 * their own copy of `readSettings` / `writeSettings`, and the write was a
 * plain `fs.writeFileSync`. If two `work` processes started concurrently —
 * or one was killed mid-write — the user's global hooks would be silently
 * truncated. That breaks hooks for every project, not just `work`.
 *
 * Everything here writes through `editSettings`, which does a single
 * tmp-file + rename atomic write under a process-level mutex (best-effort —
 * no cross-process locking, but the rename is OS-atomic and the in-process
 * mutex is enough to serialize the dash + web case).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const OWNER_TAG = '_workHookOwner';
const PID_TAG = '_workHookPid';
const LEGACY_TAGS = ['_workDash', '_work2Dash'];

export interface SettingsFile {
  hooks?: Record<string, HookEntry[] | undefined>;
  [k: string]: unknown;
}
export interface HookEntry {
  hooks?: { type: string; url?: string; command?: string; timeout?: number }[];
  matcher?: string;
  [k: string]: unknown;
}

export const HOOK_TAGS = {
  OWNER_TAG,
  PID_TAG,
  LEGACY_TAGS,
} as const;

function readSettings(): SettingsFile {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as SettingsFile;
  } catch {
    return {};
  }
}

/** Atomic write: tmp-file + rename. Caller must hold the in-process queue. */
function writeAtomic(s: SettingsFile): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    const tmp = `${SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    fs.renameSync(tmp, SETTINGS_PATH);
  } catch { /* best-effort */ }
}

/**
 * Serialise in-process edits to the settings file. Two HookServer / hook
 * installer calls from the same `work` process can't race each other.
 * (Cross-process races still exist but are bounded by the OS-atomic rename
 * — the worst case is one process's edit clobbering another's, never a
 * truncated half-written file.)
 */
let editQueue: Promise<void> = Promise.resolve();
export function editSettings(
  mutate: (s: SettingsFile) => void,
): Promise<void> {
  editQueue = editQueue.then(() => {
    const s = readSettings();
    if (!s.hooks) s.hooks = {};
    mutate(s);
    if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
    writeAtomic(s);
  });
  return editQueue;
}

/** Synchronous mutation variant — used in shutdown handlers where there's
 *  no time to await a promise. Still atomic on the rename, just doesn't
 *  participate in the in-process queue. */
export function editSettingsSync(mutate: (s: SettingsFile) => void): void {
  const s = readSettings();
  if (!s.hooks) s.hooks = {};
  mutate(s);
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeAtomic(s);
}

/** Common predicate: is this entry tagged with our owner? */
export function isOwnerEntry(h: HookEntry, owner: string): boolean {
  return h[OWNER_TAG] === owner;
}

/** Common predicate: was this entry tagged by a `work` process that's no
 *  longer running? Stale entries get pruned on every install. */
export function isStaleEntry(h: HookEntry): boolean {
  if (typeof h[OWNER_TAG] !== 'string') return false;
  const pid = h[PID_TAG];
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function isLegacyEntry(h: HookEntry): boolean {
  return LEGACY_TAGS.some((t) => (h as Record<string, unknown>)[t] === true);
}

/** Tag an entry so future installs can find/remove it. */
export function tag(entry: HookEntry, owner: string): HookEntry {
  return {
    ...entry,
    [OWNER_TAG]: owner,
    [PID_TAG]: process.pid,
  };
}
