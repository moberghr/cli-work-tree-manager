/**
 * Stage 1 of the migration to "one server per machine."
 *
 * A scope is an ad-hoc registration from a `wd` (or `wd -c`) invocation:
 * a label and a list of repo roots. Identified by the same sha1-of-roots
 * hash that `stableDiffPath` produces, so the same directory always gets
 * the same scope id across CLI invocations.
 *
 * Scopes are in-memory only — registering one doesn't touch disk. The
 * file watcher and comment store are per-scope, lazily started on first
 * access and reused thereafter.
 *
 * This module is mounted into `work web` so multiple `wd` invocations
 * share a single server process. Eventually `wd` itself will become a
 * thin client that registers a scope and opens a URL.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { createFsWatcher, type FsWatcher } from './fs-watcher.js';
import { loadConfig } from './config.js';

export interface Scope {
  /** Stable hash — same as `stableDiffPath` would emit. */
  hash: string;
  /** Repo roots this scope covers. One for a single-repo worktree,
   *  many for a group. */
  paths: string[];
  /** Optional human label (e.g. "work-tree · feat/x"). */
  label: string;
  /** When the scope was first registered. */
  createdAt: string;
  /** Set when the user clicks "End Review" in the browser. The scope
   *  itself stays alive (browser tab still works) — this is just a
   *  signal so the `wd -c` CLI proxy knows to emit
   *  `--- review done ---` and exit. */
  ended: boolean;
}

interface ScopeEntry {
  scope: Scope;
  watcher: FsWatcher | null;
  subscribers: Set<() => void>;
}

const scopes = new Map<string, ScopeEntry>();

function hashFor(paths: string[]): string {
  const key = paths.slice().sort().join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** Thrown by registerScope when the requested paths aren't inside any
 *  configured repo or under the configured worktrees root. */
export class ScopePathRejectedError extends Error {
  constructor(public rejected: string[]) {
    super(
      `paths not allowed: ${rejected.join(', ')} (must be inside a configured repo or worktreesRoot)`,
    );
    this.name = 'ScopePathRejectedError';
  }
}

function normaliseForCompare(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Reject paths that aren't inside any configured repo or under the
 * configured `worktreesRoot`. The work web server binds to 127.0.0.1
 * only, but any local process can still POST `/api/scopes` with an
 * arbitrary filesystem path — without this check a malicious npm
 * package could cause `git` and chokidar to operate on
 * `C:\Windows\System32` or the user's home root.
 *
 * Returns the rejected subset (empty array when everything's allowed).
 */
function rejectedPaths(normalised: string[]): string[] {
  const config = loadConfig();
  if (!config) {
    // No config means no allowlist to check against. Fall back to
    // permissive — `work init` hasn't been run yet, and rejecting
    // everything would break first-run flows.
    return [];
  }
  const allowed = [
    ...Object.values(config.repos),
    ...(config.worktreesRoot ? [config.worktreesRoot] : []),
  ].map(normaliseForCompare);
  if (allowed.length === 0) return [];
  return normalised.filter((p) => {
    const np = normaliseForCompare(p);
    return !allowed.some((a) => np === a || np.startsWith(a + '/'));
  });
}

/** Register a scope (idempotent). Returns the resolved entry — same call
 *  twice with the same paths gets the same hash and the same entry.
 *  Throws `ScopePathRejectedError` when any path is outside the configured
 *  repos / worktrees root. */
export function registerScope(paths: string[], label?: string): Scope {
  const normalised = paths.map((p) => path.resolve(p));
  const rejected = rejectedPaths(normalised);
  if (rejected.length > 0) throw new ScopePathRejectedError(rejected);
  const hash = hashFor(normalised);
  const existing = scopes.get(hash);
  if (existing) {
    if (label && existing.scope.label !== label) {
      existing.scope.label = label;
    }
    return existing.scope;
  }
  const scope: Scope = {
    hash,
    paths: normalised,
    label: label ?? path.basename(normalised[0]),
    createdAt: new Date().toISOString(),
    ended: false,
  };
  scopes.set(hash, { scope, watcher: null, subscribers: new Set() });
  return scope;
}

/** Mark a scope as ended (the user clicked "End Review"). Idempotent.
 *  Does NOT remove the scope — the URL stays viewable. */
export function markScopeEnded(hash: string): boolean {
  const entry = scopes.get(hash);
  if (!entry) return false;
  if (entry.scope.ended) return false;
  entry.scope.ended = true;
  return true;
}

export function getScope(hash: string): Scope | null {
  return scopes.get(hash)?.scope ?? null;
}

export function listScopes(): Scope[] {
  return Array.from(scopes.values()).map((e) => e.scope);
}

export function removeScope(hash: string): boolean {
  const entry = scopes.get(hash);
  if (!entry) return false;
  entry.watcher?.stop();
  entry.subscribers.clear();
  scopes.delete(hash);
  return true;
}

/**
 * Subscribe to file-change events for a scope. Lazy-starts the
 * chokidar watcher on first subscribe; tears it down when the last
 * subscriber unsubscribes. Same lifecycle as `web-state.subscribeSession`.
 *
 * The callback fires once per debounced fs event burst.
 */
export function subscribeScope(
  hash: string,
  cb: () => void,
): (() => void) | null {
  const entry = scopes.get(hash);
  if (!entry) return null;
  entry.subscribers.add(cb);
  if (!entry.watcher) {
    entry.watcher = createFsWatcher({
      roots: entry.scope.paths,
      debounceMs: 150,
      onChange: () => {
        for (const sub of entry.subscribers) {
          try { sub(); } catch { /* */ }
        }
      },
    });
  }
  return () => {
    entry.subscribers.delete(cb);
    if (entry.subscribers.size === 0 && entry.watcher) {
      entry.watcher.stop();
      entry.watcher = null;
    }
  };
}

/** Shut down every scope's watcher. Web server shutdown hook. */
export function disposeAllScopes(): void {
  for (const e of scopes.values()) {
    e.watcher?.stop();
    e.subscribers.clear();
  }
  scopes.clear();
}

/** Build a comment-store id for a scope. Distinguishes from session
 *  ids so the two namespaces can't collide on disk. */
export function commentStoreIdForScope(hash: string): string {
  return `scope-${hash}`;
}
