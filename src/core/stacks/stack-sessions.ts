import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { mergedParent, stackChildCounts, stackParents } from './stack.js';
import fs from 'node:fs';
import { archiveDirFor, readArchive } from '../archive/session-archive.js';

const mergedCache = new Map<string, { key: string; merged: boolean }>();

/**
 * Its archive says it merged: a merged PR, or its branch deleted as merged
 * into main. Read once per change of archive.json (a stat, not a parse, on
 * every /api/sessions build).
 */
function archivedAsMerged(id: string): boolean {
  let key: string;
  try {
    const st = fs.statSync(path.join(archiveDirFor(id), 'archive.json'));
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return false;
  }
  const hit = mergedCache.get(id);
  if (hit?.key === key) return hit.merged;
  const a = readArchive(id);
  const merged = !!a && (a.summary.prs.some((p) => p.state === 'MERGED') || (a.branchesDeleted?.length ?? 0) > 0);
  mergedCache.set(id, { key, merged });
  while (mergedCache.size > 1000) mergedCache.delete(mergedCache.keys().next().value!);
  return merged;
}

export type StackedSession = WorktreeSession & { id: string };

export interface Stacks {
  /** Session id → the session it is stacked on. */
  parentOf: Map<string, StackedSession>;
  /** Session id → how many are stacked on it. */
  children: Map<string, number>;
  /** Session id → the archived (merged) session it was made from: time to move onto main. */
  mergedParentOf: Map<string, StackedSession>;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/**
 * The stacks among these sessions (stack.ts). A repo's own checkout is never
 * a parent: a session opened on the base checkout (`work tree <repo>`) sits
 * on whatever branch that is, and everything made from it isn't stacked.
 */
export function sessionStacks(history: readonly WorktreeSession[], config: WorkConfig | null): Stacks {
  const repoRoots = new Set(Object.values(config?.repos ?? {}).map(norm));
  const all: StackedSession[] = history.map((s) => ({ ...s, id: sessionIdFor(s) }));
  const eligible = (p: StackedSession) => !p.paths.some((x) => repoRoots.has(norm(x)));
  const parentOf = stackParents(all, eligible);
  const mergedParentOf = new Map<string, StackedSession>();
  for (const s of all) {
    const m = parentOf.has(s.id) ? null : mergedParent(s, all, eligible, (p) => archivedAsMerged(p.id));
    if (m) mergedParentOf.set(s.id, m);
  }
  return { parentOf, children: stackChildCounts(parentOf), mergedParentOf };
}

/** The sessions stacked on this one (live ones). */
export function stackedOn(parentId: string, stacks: Stacks, history: readonly WorktreeSession[]): WorktreeSession[] {
  return history.filter((s) => stacks.parentOf.get(sessionIdFor(s))?.id === parentId);
}
