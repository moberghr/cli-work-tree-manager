import { json, tx, withDb } from './db.js';
import { isPersistedPty, type PersistedPtys } from './pty-host-protocol.js';

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
 * Drop one session from the restore list without a running host, so the
 * next host start doesn't restore it (its worktree is being deleted).
 */
export async function forgetPersistedSession(id: string): Promise<void> {
  withDb((d) => d.prepare('DELETE FROM pty_sessions WHERE session_id = ?').run(id));
}
