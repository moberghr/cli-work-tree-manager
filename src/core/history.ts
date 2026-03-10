import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

export interface WorktreeSession {
  target: string;
  isGroup: boolean;
  branch: string;
  paths: string[];
  createdAt: string;
  lastAccessedAt: string;
}

export function getHistoryPath(): string {
  return path.join(getConfigDir(), 'history.json');
}

export function loadHistory(): WorktreeSession[] {
  const historyPath = getHistoryPath();
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveHistory(sessions: WorktreeSession[]): void {
  const historyPath = getHistoryPath();
  fs.writeFileSync(historyPath, JSON.stringify(sessions, null, 2), 'utf-8');
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

export function upsertSession(
  target: string,
  isGroup: boolean,
  branch: string,
  paths: string[],
): void {
  const sessions = loadHistory();
  const existing = findSession(sessions, target, branch);
  const now = new Date().toISOString();

  if (existing) {
    existing.paths = paths;
    existing.lastAccessedAt = now;
  } else {
    sessions.push({
      target,
      isGroup,
      branch,
      paths,
      createdAt: now,
      lastAccessedAt: now,
    });
  }

  saveHistory(sessions);
}

export function removeSession(target: string, branch: string): void {
  const sessions = loadHistory();
  const filtered = sessions.filter(
    (s) => !(s.target === target && s.branch === branch),
  );

  if (filtered.length !== sessions.length) {
    saveHistory(filtered);
  }
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
        new Date(b.lastAccessedAt).getTime() -
        new Date(a.lastAccessedAt).getTime(),
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
