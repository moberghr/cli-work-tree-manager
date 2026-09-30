import fs from 'node:fs';
import path from 'node:path';
import type { WorktreeSession } from './history.js';
import { sessionIdFor } from './session-id.js';

/**
 * History can hold several sessions for ONE folder: branches you had checked
 * out in a base repo before `work tree` kept one entry per base checkout.
 * Everything read from the folder — Claude's transcripts, its running
 * Claudes — belongs to one of them, not all: otherwise every old entry of a
 * busy checkout shows as Active. The owner is the entry for the branch
 * checked out there now; failing that, the one entered last.
 */

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** Ids of the sessions that share a folder with its owner (the rest). */
export function shadowedSessions(
  sessions: WorktreeSession[],
  branchCheckedOut: (dir: string) => string | null,
): Set<string> {
  const byFolder = new Map<string, WorktreeSession[]>();
  for (const s of sessions) {
    if (s.isGroup || s.paths.length !== 1) continue;
    const key = norm(s.paths[0]);
    byFolder.set(key, [...(byFolder.get(key) ?? []), s]);
  }
  const shadowed = new Set<string>();
  for (const group of byFolder.values()) {
    if (group.length < 2) continue;
    const current = branchCheckedOut(group[0].paths[0]);
    const owner =
      group.find((s) => s.branch === current) ??
      [...group].sort((a, b) => (Date.parse(b.lastAccessedAt) || 0) - (Date.parse(a.lastAccessedAt) || 0))[0];
    for (const s of group) if (s !== owner) shadowed.add(sessionIdFor(s));
  }
  return shadowed;
}

/** The branch checked out in `dir`, read from .git/HEAD (no git process); null if detached or unreadable. */
export function branchCheckedOut(dir: string): string | null {
  try {
    const dotGit = path.join(dir, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      // A linked worktree: ".git" is a file naming its real git dir.
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
    return ref ? ref[1].trim() : null;
  } catch {
    return null;
  }
}
