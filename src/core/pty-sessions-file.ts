import { json, tx, withDb } from './db.js';
import fs from 'node:fs';
import { isPersistedPty, ptySessionsPath, type PersistedPtys } from './pty-host-protocol.js';

/**
 * The PTY host's restore list: which sessions were live, so a host restart
 * (or reboot) brings them back. state.db's `pty_sessions` (session_id →
 * spawn spec JSON). Kept apart from pty-registry.ts so callers (work web,
 * the CLI) don't load node-pty just to read or edit it.
 */

/** Where the registry keeps its restore list (injectable for tests). */
export interface PtySessionsStore {
  read(): PersistedPtys;
  /** Replace the whole list. */
  write(all: PersistedPtys): void;
}

export const dbPtySessions: PtySessionsStore = {
  read() {
    const out: PersistedPtys = {};
    for (const r of withDb((d) => d.prepare('SELECT session_id, data FROM pty_sessions').all() as Array<{ session_id: string; data: string }>)) {
      const entry = json.parse(r.data);
      if (isPersistedPty(entry)) out[r.session_id] = entry;
    }
    return out;
  },
  write(all) {
    tx((d) => {
      d.prepare('DELETE FROM pty_sessions').run();
      const ins = d.prepare('INSERT INTO pty_sessions (session_id, data) VALUES (?, ?)');
      for (const [id, spec] of Object.entries(all)) ins.run(id, JSON.stringify(spec));
    });
  },
};

/**
 * A pty-sessions.json present at host start was written by an OLDER host
 * (protocol v1) that kept running across the upgrade to state.db: after the
 * one-time import renamed the file, that host re-created it and went on
 * recording sessions there. It is the newest list, so it replaces the
 * database's — otherwise sessions started after the upgrade would not be
 * restored, and ones it forgot would come back. Returns how many entries
 * it adopted (null: no file).
 */
export function adoptLegacyRestoreList(file = ptySessionsPath()): number | null {
  if (!fs.existsSync(file)) return null;
  const adopted: PersistedPtys = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object') {
      for (const [id, entry] of Object.entries(raw)) if (isPersistedPty(entry)) adopted[id] = entry;
    }
  } catch {
    return null; // unreadable: leave it, and the database's list, alone
  }
  dbPtySessions.write(adopted);
  try {
    fs.renameSync(file, `${file}.adopted-${Date.now()}`);
  } catch {
    /* adopted already; a leftover file is adopted again next start */
  }
  return Object.keys(adopted).length;
}

/**
 * Drop one session from the restore list without a running host, so the
 * next host start doesn't restore it (its worktree is being deleted).
 */
export async function forgetPersistedSession(id: string): Promise<void> {
  withDb((d) => d.prepare('DELETE FROM pty_sessions WHERE session_id = ?').run(id));
}
