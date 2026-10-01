import path from 'node:path';
import type { WorkConfig } from './config.js';
import { sessionIdFor } from './session-id.js';
import type { WorktreeSession } from './session-types.js';
import { stackChildCounts, stackParents } from './stack.js';

export type StackedSession = WorktreeSession & { id: string };

export interface Stacks {
  /** Session id → the session it is stacked on. */
  parentOf: Map<string, StackedSession>;
  /** Session id → how many are stacked on it. */
  children: Map<string, number>;
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
  const parentOf = stackParents(all, (p) => !p.paths.some((x) => repoRoots.has(norm(x))));
  return { parentOf, children: stackChildCounts(parentOf) };
}

/** The sessions stacked on this one (live ones). */
export function stackedOn(parentId: string, stacks: Stacks, history: readonly WorktreeSession[]): WorktreeSession[] {
  return history.filter((s) => stacks.parentOf.get(sessionIdFor(s))?.id === parentId);
}
