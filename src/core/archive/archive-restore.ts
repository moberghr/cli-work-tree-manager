import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import type { WorktreeSession } from '../sessions/history.js';
import { archiveDirFor, archiveRoot, readArchive, writeArchiveRecord } from './session-archive.js';
import { restoreUncommitted } from './archive-uncommitted.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { report } from '../platform/report.js';

/**
 * Restore of an archived session whose worktree was removed: put back the
 * uncommitted work archiving saved (archive-uncommitted.ts), once. A repo
 * whose save was put back, or couldn't be, isn't tried again — a later
 * `work tree` into it must not bring old changes back over newer work. What
 * couldn't be put back says where it is (its ref and patch stay).
 */
export async function restoreArchivedUncommitted(s: WorktreeSession, config: WorkConfig, root = archiveRoot()): Promise<{ restored: string[]; failed: Array<{ repo: string; error: string }> }> {
  const id = sessionIdFor(s);
  const rec = readArchive(id, root);
  const out = { restored: [] as string[], failed: [] as Array<{ repo: string; error: string }> };
  if (!rec?.worktreeRemoved || !rec.uncommitted) return out;
  const dir = archiveDirFor(id, root);
  const now = new Date().toISOString();
  let changed = false;
  for (const [alias, saved] of Object.entries(rec.uncommitted)) {
    if (saved.restoredAt || saved.restoreError) continue;
    const wt = worktreeFor(s, alias, config);
    const r = wt ? await restoreUncommitted(wt, saved, dir) : { ok: false as const, error: `no worktree of ${alias} in the session` };
    if (r.ok) {
      saved.restoredAt = now;
      out.restored.push(alias);
      report('info', `${alias}: put back ${saved.files} uncommitted file${saved.files === 1 ? '' : 's'} saved when it was archived`);
    } else {
      saved.restoreError = r.error;
      out.failed.push({ repo: alias, error: r.error });
      report('warn', `${alias}: its uncommitted changes from the archive weren't put back: ${r.error}`);
    }
    changed = true;
  }
  if (changed) writeArchiveRecord(rec, root);
  return out;
}

/** The session's worktree of a repo: its only path, or (a group) the one named after the repo's folder. */
function worktreeFor(s: WorktreeSession, alias: string, config: WorkConfig): string | null {
  if (!s.isGroup) return s.paths[0] ?? null;
  const repo = config.repos[alias];
  if (!repo) return null;
  const name = path.basename(repo).toLowerCase();
  return s.paths.find((p) => path.basename(p).toLowerCase() === name) ?? null;
}
