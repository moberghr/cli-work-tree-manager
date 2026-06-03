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

export function isViewed(scope: string, filePath: string): boolean {
  return store.has(scope, filePath);
}

export function setViewed(
  scope: string,
  filePath: string,
  viewed: boolean,
): void {
  store.set(scope, filePath, viewed);
}

export function readScope(scope: string): Set<string> {
  return store.readScope(scope);
}
