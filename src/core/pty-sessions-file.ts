import fs from 'node:fs';
import { atomicWriteFile, withFileLock } from './fs-safe.js';
import { ptySessionsPath } from './pty-host-protocol.js';

// Edits to ~/.work/pty-sessions.json that don't need a running host — kept
// apart from pty-registry.ts so callers (work web, the CLI) don't load
// node-pty just to edit a JSON file.
/**
 * Drop one session from the persisted list without a running host, so the
 * next host start doesn't restore it (its worktree is being deleted).
 */
export async function forgetPersistedSession(
  id: string,
  sessionsPath: string = ptySessionsPath(),
): Promise<void> {
  if (!fs.existsSync(sessionsPath)) return;
  await withFileLock(sessionsPath, () => {
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    } catch {
      return;
    }
    if (!saved || !(id in saved)) return;
    delete saved[id];
    atomicWriteFile(sessionsPath, JSON.stringify(saved, null, 2));
  });
}
