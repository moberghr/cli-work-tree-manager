/**
 * Atomic read/edit/write helpers for `~/.claude/settings.json` — the user's
 * global Claude Code settings.
 *
 * `installCommandHook` mutates this file at `work web` startup/shutdown.
 * (The retired `work dash` also installed http-type hooks here; any it left
 * behind are tagged with a dead PID and pruned as stale on the next
 * install.) Writes used to be a plain `fs.writeFileSync`. If two `work` processes started concurrently —
 * or one was killed mid-write — the user's global hooks would be silently
 * truncated. That breaks hooks for every project, not just `work`.
 *
 * Everything here writes through `editSettings`: a tmp-file + rename atomic
 * write, under an in-process queue and a cross-process file lock (§5.2).
 * The rename follows symlinks (`atomicWriteFile`) so a settings.json
 * symlinked into a dotfiles repo keeps being a symlink. A file that exists
 * but doesn't parse is never replaced, and the first edit keeps a
 * `settings.json.work-backup`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile, ensureFile, resolveLinkTarget, withFileLock, withFileLockSync } from './fs-safe.js';
import { report } from './report.js';

/** Resolved lazily (not at module load) so tests can stub `os.homedir`. */
function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}
const OWNER_TAG = '_workHookOwner';
const PID_TAG = '_workHookPid';

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
} as const;

type Read =
  | { kind: 'ok'; settings: SettingsFile }
  /** No file yet: start from an empty one. */
  | { kind: 'missing' }
  /** The file exists but isn't valid JSON (a hand edit in progress, another
   *  tool mid-write). NOT the same as empty: writing now would replace the
   *  user's permissions, env, model… with just our hooks. */
  | { kind: 'unreadable'; error: string };

function readSettings(file: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: (err as Error).message };
  }
  if (!text.trim()) return { kind: 'missing' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable', error: 'not a JSON object' };
    return { kind: 'ok', settings: parsed as SettingsFile };
  } catch (err) {
    return { kind: 'unreadable', error: (err as Error).message };
  }
}

/** One backup per file per process, of the file as it was before this
 *  process first edited it. */
const backedUp = new Set<string>();
function backupOnce(file: string): void {
  if (backedUp.has(file) || !fs.existsSync(file)) return;
  try {
    fs.copyFileSync(file, `${file}.work-backup`);
    backedUp.add(file);
  } catch {
    /* best-effort */
  }
}

/**
 * The read-modify-write, under a cross-process lock on the real file (the
 * symlink target): Claude Code saving settings, a lean `work web` autostarted
 * by `wd` installing hooks and a full one shutting down can all edit this
 * file at once, and an unlocked rewrite drops one side's edit. Returns
 * false when the file couldn't be read and was left untouched.
 */
function applyEdit(file: string, mutate: (s: SettingsFile) => void): boolean {
  const read = readSettings(file);
  if (read.kind === 'unreadable') {
    report(
      'error',
      `[work] ${file} is not valid JSON (${read.error}) — left it alone; work's Claude hooks were not updated. Fix the file and restart work web.`,
    );
    return false;
  }
  const s = read.kind === 'ok' ? read.settings : {};
  if (!s.hooks) s.hooks = {};
  mutate(s);
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  backupOnce(file);
  // Trailing newline: this file is commonly symlinked into a dotfiles repo,
  // and a missing one shows up as a diff artefact on every edit.
  atomicWriteFile(file, `${JSON.stringify(s, null, 2)}\n`);
  return true;
}

function target(): string {
  const t = resolveLinkTarget(settingsPath());
  fs.mkdirSync(path.dirname(t), { recursive: true });
  return t;
}

/**
 * Edit the settings file: atomic (tmp + rename, through a symlink to the
 * real file), serialised within this process AND locked across processes.
 * An unparsable file is never replaced.
 */
let editQueue: Promise<unknown> = Promise.resolve();
export function editSettings(mutate: (s: SettingsFile) => void): Promise<void> {
  const run = editQueue.then(async () => {
    try {
      const file = target();
      if (!fs.existsSync(file)) ensureFile(file, '{}\n');
      await withFileLock(file, () => applyEdit(file, mutate));
    } catch (err) {
      report('error', `[work] could not update Claude settings: ${(err as Error).message}`);
    }
  });
  editQueue = run;
  return run;
}

/** Synchronous variant — shutdown handlers, where there's no time to await.
 *  Same lock and the same refusal to overwrite an unparsable file. */
export function editSettingsSync(mutate: (s: SettingsFile) => void): void {
  try {
    const file = target();
    if (!fs.existsSync(file)) ensureFile(file, '{}\n');
    withFileLockSync(file, () => applyEdit(file, mutate));
  } catch (err) {
    report('error', `[work] could not update Claude settings: ${(err as Error).message}`);
  }
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

/** Tag an entry so future installs can find/remove it. */
export function tag(entry: HookEntry, owner: string): HookEntry {
  return {
    ...entry,
    [OWNER_TAG]: owner,
    [PID_TAG]: process.pid,
  };
}
