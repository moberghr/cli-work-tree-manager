/**
 * Per-browser tracking of which individual diff hunks in a review/scope
 * have been checked off ("reviewed") by the reviewer. Survives reload via
 * localStorage. Each scope (a wd -c review or a session in the dashboard)
 * gets its own bucket so reviewed state doesn't leak across worktrees.
 *
 * The inner key is a hunk content key (see hunk-key.ts) — derived from the
 * hunk body, NOT its line numbers, so it stays stable across live-reload
 * edits elsewhere in the file.
 *
 * Storage shape: { [scopeKey]: { [hunkKey]: true } }
 */
import { createScopeMapStore } from './scope-map-store.js';

const store = createScopeMapStore('work-web:reviewed-hunks');

export function isReviewed(scope: string, hunkKey: string): boolean {
  return store.has(scope, hunkKey);
}

export function setReviewed(
  scope: string,
  hunkKey: string,
  reviewed: boolean,
): void {
  store.set(scope, hunkKey, reviewed);
}

export function readScope(scope: string): Set<string> {
  return store.readScope(scope);
}
