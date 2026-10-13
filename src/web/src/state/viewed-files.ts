/**
 * Per-browser tracking of which files in a review/scope have been marked
 * "viewed". Survives reload via localStorage. Each scope (a wd -c review or
 * a session in the dashboard) gets its own bucket so files don't leak
 * across worktrees.
 *
 * Storage shape: { [scopeKey]: { [filePath]: true } }
 */
import { createScopeMapStore } from './scope-map-store.js';

const store = createScopeMapStore('work-web:viewed-files');

export function readScope(scope: string): Set<string> {
  return store.readScope(scope);
}

/** Change a scope's ticks in one store pass (the one way to write them: use-viewed-files keeps one tick per file). Returns them after. */
export function updateScope(scope: string, change: (keys: Set<string>) => void): Set<string> {
  return store.update(scope, change);
}
