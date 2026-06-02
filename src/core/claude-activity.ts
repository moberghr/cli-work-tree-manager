import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeSession } from './history.js';

/**
 * Claude Code writes each session as JSONL under
 * `~/.claude/projects/<encoded-cwd>/`, where the encoded path replaces every
 * non-alphanumeric character with `-`. These files get rewritten on every
 * message, so their mtimes reflect actual conversation activity — which is
 * what the user cares about, not when `work tree` was last invoked.
 */
function encodeProjectDir(p: string): string {
  return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

function latestJsonlMtimeMs(projectDir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return 0;
  }
  let latest = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const stat = fs.statSync(path.join(projectDir, name));
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch {
      /* ignore unreadable entries */
    }
  }
  return latest;
}

export function getClaudeActivityMs(launchPath: string): number {
  const dir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeProjectDir(launchPath),
  );
  return latestJsonlMtimeMs(dir);
}

function getLaunchPaths(session: WorktreeSession): string[] {
  if (!session.isGroup) return [...session.paths];
  // Groups launch Claude in the parent (group root), not a repo subfolder.
  const parents = new Set<string>();
  for (const p of session.paths) parents.add(path.dirname(p));
  return [...parents];
}

/**
 * Returns the most recent of the session's persisted `lastAccessedAt` and
 * the mtime of Claude's session logs for this worktree's launch path(s).
 */
export function effectiveLastAccessedAt(session: WorktreeSession): string {
  let bestMs = new Date(session.lastAccessedAt).getTime();
  if (!Number.isFinite(bestMs)) bestMs = 0;
  for (const p of getLaunchPaths(session)) {
    const ms = getClaudeActivityMs(p);
    if (ms > bestMs) bestMs = ms;
  }
  return new Date(bestMs).toISOString();
}

export type ActivityState = 'active' | 'open' | 'stale';

/** Active: Claude wrote a turn in the last 30 s — currently thinking. */
const ACTIVE_MS = 30_000;
/** Open: Claude touched the transcript within 5 min — terminal still attached,
 *  just idle. After this we consider the session stale. */
const OPEN_MS = 5 * 60_000;

export interface SessionActivity {
  /** ms since epoch of the most recent Claude write across this session's
   *  launch path(s), or null if no transcript exists. */
  lastActivity: number | null;
  state: ActivityState;
}

/**
 * Derive an activity state for a session by looking at Claude's transcript
 * mtime. Works whether the user launched Claude via `work tree`, `work dash`,
 * a manual terminal, or `work web`'s own PTY — they all write to the same
 * `~/.claude/projects/<encoded-cwd>/` directory.
 *
 * If Claude's on-disk layout ever changes, the function falls back to
 * "stale" gracefully and the dashboard's other status signals (e.g. our own
 * PTY pool) keep working.
 */
export function readSessionActivity(session: WorktreeSession): SessionActivity {
  let latest = 0;
  for (const p of getLaunchPaths(session)) {
    const ms = getClaudeActivityMs(p);
    if (ms > latest) latest = ms;
  }
  if (latest === 0) return { lastActivity: null, state: 'stale' };
  const age = Date.now() - latest;
  const state: ActivityState =
    age <= ACTIVE_MS ? 'active' : age <= OPEN_MS ? 'open' : 'stale';
  return { lastActivity: latest, state };
}

/** Watch root: `~/.claude/projects/`. The web server subscribes to mtime
 *  changes here and re-broadcasts `sessions-changed` so the sidebar
 *  badges refresh without polling. */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}
