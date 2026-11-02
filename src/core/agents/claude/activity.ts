import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeSession } from '../../sessions/session-types.js';
import { claudeAccounts, configDirEnv, sessionAccount } from './accounts.js';

/**
 * Claude Code writes each session as JSONL under
 * `~/.claude/projects/<encoded-cwd>/`, where the encoded path replaces every
 * non-alphanumeric character with `-`. These files get rewritten on every
 * message, so their mtimes reflect actual conversation activity — which is
 * what the user cares about, not when `work tree` was last invoked.
 */
export function encodeProjectDir(p: string): string {
  return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

export interface ProjectFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/** A folder's transcript names, and when and at which folder mtime they were read. */
const listings = new Map<string, { at: number; dirMtimeMs: number; names: string[] }>();
/** The longest a folder's names are reused while its mtime says unchanged:
 *  NTFS doesn't always update a folder's mtime at once when a file is added. */
export const NAMES_MAX_AGE_MS = 2000;

/**
 * The transcripts in a Claude project folder (name, mtime, size). The
 * folder's names are read again when the folder changed (its mtime) or are
 * NAMES_MAX_AGE_MS old: one stat instead of a directory read for the three
 * readers each session-list build has per session (activity, name, context
 * use). Each file is stat'ed every time, so sizes and times are exact.
 * Bounded by the folders there are.
 */
export function projectTranscripts(projectDir: string, now = Date.now()): ProjectFile[] {
  let dirMtimeMs: number;
  try {
    dirMtimeMs = fs.statSync(projectDir).mtimeMs;
  } catch {
    listings.delete(projectDir);
    return []; // no conversation here yet
  }
  let hit = listings.get(projectDir);
  if (!hit || hit.dirMtimeMs !== dirMtimeMs || now - hit.at >= NAMES_MAX_AGE_MS) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      /* gone meanwhile */
    }
    hit = { at: now, dirMtimeMs, names };
    listings.set(projectDir, hit);
  }
  const files: ProjectFile[] = [];
  for (const name of hit.names) {
    try {
      const file = path.join(projectDir, name);
      const st = fs.statSync(file);
      files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished */
    }
  }
  return files;
}

function latestJsonlMtimeMs(projectDir: string): number {
  let latest = 0;
  for (const f of projectTranscripts(projectDir)) if (f.mtimeMs > latest) latest = f.mtimeMs;
  return latest;
}

/** An account's projects folder: `<its config folder, or ~/.claude>/projects`. */
export function projectsRootOf(configDir?: string): string {
  return path.join(configDir || path.join(os.homedir(), '.claude'), 'projects');
}

/**
 * Every account's projects folder, the default account's first; `first` (an account name) goes in front of the others —
 * a session's own account is looked in before the rest. Each folder once.
 */
export function claudeProjectsRoots(first?: string): string[] {
  const accounts = claudeAccounts();
  const ordered = first ? [...accounts.filter((a) => a.name === first), ...accounts.filter((a) => a.name !== first)] : accounts;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of ordered) {
    const root = projectsRootOf(a.dir);
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** Its newest transcript write in ONE config folder's projects (`~/.claude` without one). */
const activityIn = (launchPath: string, configDir?: string): number =>
  latestJsonlMtimeMs(path.join(projectsRootOf(configDir), encodeProjectDir(launchPath)));

/**
 * The newest transcript write for work in `launchPath`: in that config folder's projects when `configDir` is given, else
 * the newest across every account (where no session is known: a `wd` scope, the PR watch's "was it used lately").
 */
export function getClaudeActivityMs(launchPath: string, configDir?: string): number {
  if (configDir) return activityIn(launchPath, configDir);
  let latest = 0;
  for (const root of claudeProjectsRoots()) latest = Math.max(latest, latestJsonlMtimeMs(path.join(root, encodeProjectDir(launchPath))));
  return latest;
}

/**
 * True when the AI tool's resume flag (`--continue`) will actually find a
 * conversation for this exact cwd. Claude Code errors out with "No conversation
 * found to continue" when the flag is passed in a directory it has never run
 * in, so callers gate on this before adding it.
 */
export function hasClaudeConversation(dir: string, configDir?: string): boolean {
  // One folder, never every account's: `--continue` finds only the conversations of the config folder it runs with.
  return activityIn(dir, configDir) > 0;
}

/**
 * The folders Claude may have been run in for a session — the cwds its conversations are keyed by: for a group its
 * root(s) and each sub-repo, for a single repo the repo path. `existing`: only the ones still on disk (a launch needs
 * one), else all (a switch of account moves the conversations of a folder that is gone too).
 */
export function sessionRunFolders(session: Pick<WorktreeSession, 'paths' | 'isGroup'>, existing = true): string[] {
  const paths = existing ? session.paths.filter((p) => fs.existsSync(p)) : session.paths;
  const out = new Set<string>();
  if (session.isGroup) {
    for (const p of paths) out.add(path.dirname(p)); // group root(s)
    for (const p of paths) out.add(p); // sub-repos
  } else {
    for (const p of paths) out.add(p);
  }
  return [...out];
}

/**
 * Pick the directory to relaunch Claude in when resuming a session.
 *
 * Claude's `--continue` only finds a conversation when the launch cwd matches
 * the directory the transcript was written for. A group session may have been
 * worked in the group root OR inside a specific sub-repo, and a session may
 * have no transcript at all (Claude was never actually used). So we consider
 * every plausible cwd — group root(s) and each sub-repo for groups, the repo
 * path for single-repo sessions — and pick the one with the most recent
 * transcript.
 *
 * Returns `hasConversation: false` (with the default launch path) when no
 * transcript exists anywhere; the caller should then start a fresh session
 * instead of passing `--continue`, which would error out and drop the user
 * back to the shell.
 */
export function resolveResumeLaunch(session: WorktreeSession): {
  launchPath: string;
  hasConversation: boolean;
} {
  const existing = session.paths.filter((p) => fs.existsSync(p));
  const first = existing[0] ?? session.paths[0];
  // Default cwd: group root (parent of a sub-repo) for groups, the repo path
  // itself for single-repo sessions.
  const defaultPath = session.isGroup ? path.dirname(first) : first;

  const candidates = sessionRunFolders(session);

  // The session's own account: its conversations are in that account's folder.
  const configDir = configDirEnv(sessionAccount(session)).CLAUDE_CONFIG_DIR;
  let launchPath = defaultPath;
  let bestMs = 0;
  for (const c of candidates) {
    const ms = activityIn(c, configDir);
    if (ms > bestMs) {
      bestMs = ms;
      launchPath = c;
    }
  }
  return { launchPath, hasConversation: bestMs > 0 };
}

/** Watch root: `~/.claude/projects/`. The web server subscribes to mtime
 *  changes here and re-broadcasts `sessions-changed` so the sidebar
 *  badges refresh without polling. */
export function claudeProjectsRoot(): string {
  return projectsRootOf();
}
