import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile, ensureFile, withFileLock } from './fs-safe.js';
import { effectiveLastAccessedAt } from './claude-activity.js';

export interface WorktreeSession {
  target: string;
  isGroup: boolean;
  branch: string;
  paths: string[];
  createdAt: string;
  lastAccessedAt: string;
  jiraKey?: string;
}

export function getHistoryPath(): string {
  return path.join(getConfigDir(), 'history.json');
}

/**
 * Back up a corrupt history file so the user can recover manually
 * instead of having it silently overwritten.
 */
function backupCorruptFile(historyPath: string, reason: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${historyPath}.bad-${stamp}`;
    fs.copyFileSync(historyPath, backupPath);
    console.error(
      `[work] history.json was unreadable (${reason}). Corrupt copy saved to ${backupPath}`,
    );
  } catch {
    // best-effort
  }
}

export function loadHistory(): WorktreeSession[] {
  const historyPath = getHistoryPath();
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(historyPath, 'utf-8');
  } catch (err) {
    backupCorruptFile(historyPath, `read error: ${(err as Error).message}`);
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      backupCorruptFile(historyPath, 'not an array');
      return [];
    }
    return parsed;
  } catch (err) {
    backupCorruptFile(historyPath, `parse error: ${(err as Error).message}`);
    return [];
  }
}

export function saveHistory(sessions: WorktreeSession[]): void {
  atomicWriteFile(getHistoryPath(), JSON.stringify(sessions, null, 2));
}

/**
 * Serialize a read-modify-write sequence against other work processes.
 * Concurrent `work tree`/`remove` calls would otherwise clobber each
 * other's writes (this is the bug that wiped 60+ sessions).
 */
async function withHistoryLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const historyPath = getHistoryPath();
  ensureFile(historyPath, '[]');
  return withFileLock(historyPath, fn);
}

function sessionKey(target: string, branch: string): string {
  return `${target}:${branch}`;
}

export function findSession(
  sessions: WorktreeSession[],
  target: string,
  branch: string,
): WorktreeSession | undefined {
  return sessions.find(
    (s) => s.target === target && s.branch === branch,
  );
}

export async function upsertSession(
  target: string,
  isGroup: boolean,
  branch: string,
  paths: string[],
  jiraKey?: string,
): Promise<void> {
  await withHistoryLock(() => {
    const sessions = loadHistory();
    const existing = findSession(sessions, target, branch);
    const now = new Date().toISOString();

    if (existing) {
      existing.paths = paths;
      existing.lastAccessedAt = now;
      if (jiraKey) existing.jiraKey = jiraKey;
    } else {
      const session: WorktreeSession = {
        target,
        isGroup,
        branch,
        paths,
        createdAt: now,
        lastAccessedAt: now,
      };
      if (jiraKey) session.jiraKey = jiraKey;
      sessions.push(session);
    }

    saveHistory(sessions);
  });
}

export async function removeSession(target: string, branch: string): Promise<void> {
  await withHistoryLock(() => {
    const sessions = loadHistory();
    const filtered = sessions.filter(
      (s) => !(s.target === target && s.branch === branch),
    );

    if (filtered.length !== sessions.length) {
      saveHistory(filtered);
    }
  });
}

export function getSessionsForTarget(
  sessions: WorktreeSession[],
  target: string,
): WorktreeSession[] {
  return sessions.filter((s) => s.target === target);
}

export function getRecentSessions(
  sessions: WorktreeSession[],
  count: number,
): WorktreeSession[] {
  return [...sessions]
    .sort(
      (a, b) =>
        new Date(effectiveLastAccessedAt(b)).getTime() -
        new Date(effectiveLastAccessedAt(a)).getTime(),
    )
    .slice(0, count);
}

export function pruneStaleEntries(sessions: WorktreeSession[]): {
  kept: WorktreeSession[];
  pruned: number;
} {
  const kept: WorktreeSession[] = [];
  let pruned = 0;

  for (const session of sessions) {
    const anyPathExists = session.paths.some((p) => fs.existsSync(p));
    if (anyPathExists) {
      kept.push(session);
    } else {
      pruned++;
    }
  }

  return { kept, pruned };
}

/** Locked variant of prune for `status --prune` callers. */
export async function prunePersistedStaleEntries(): Promise<{ pruned: number }> {
  return withHistoryLock(() => {
    const sessions = loadHistory();
    const { kept, pruned } = pruneStaleEntries(sessions);
    if (pruned > 0) saveHistory(kept);
    return { pruned };
  });
}

/**
 * Merge hydrated sessions into history without clobbering existing entries.
 * For each incoming session: if a matching target+branch exists, refresh its
 * paths (if different) but keep original timestamps. Otherwise insert.
 */
export async function mergeHydratedSessions(
  incoming: WorktreeSession[],
): Promise<{ added: number; updated: number }> {
  return withHistoryLock(() => {
    const sessions = loadHistory();
    let added = 0;
    let updated = 0;

    for (const inc of incoming) {
      const existing = findSession(sessions, inc.target, inc.branch);
      if (existing) {
        const sortedA = [...existing.paths].sort();
        const sortedB = [...inc.paths].sort();
        const same =
          sortedA.length === sortedB.length &&
          sortedA.every((p, i) => p === sortedB[i]);
        if (!same) {
          existing.paths = inc.paths;
          updated++;
        }
      } else {
        sessions.push(inc);
        added++;
      }
    }

    if (added > 0 || updated > 0) {
      saveHistory(sessions);
    }
    return { added, updated };
  });
}
