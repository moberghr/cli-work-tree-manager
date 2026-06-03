/**
 * Factory for a per-scope, per-key boolean store backed by localStorage.
 *
 * Both "viewed files" and "reviewed hunks" are the same shape: a bucket per
 * scope (a wd -c review or a session in the dashboard) holding a set of
 * string keys (file paths / hunk content keys) that the reviewer has checked
 * off. Each gets its own localStorage KEY so state doesn't leak between the
 * two features or across worktrees.
 *
 * Storage shape: { [scopeKey]: { [itemKey]: true } }
 */
export interface ScopeMapStore {
  /** Whether `itemKey` is set within `scope`. */
  has(scope: string, itemKey: string): boolean;
  /** Set or clear `itemKey` within `scope`; prunes empty scopes. */
  set(scope: string, itemKey: string, on: boolean): void;
  /** Every set key within `scope`, as a Set. */
  readScope(scope: string): Set<string>;
}

type ScopeMap = Record<string, Record<string, boolean>>;

export function createScopeMapStore(storageKey: string): ScopeMapStore {
  function read(): ScopeMap {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as ScopeMap) : {};
    } catch {
      return {};
    }
  }

  function write(map: ScopeMap): void {
    try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch { /* */ }
  }

  return {
    has(scope, itemKey) {
      return !!read()[scope]?.[itemKey];
    },
    set(scope, itemKey, on) {
      const map = read();
      if (!map[scope]) map[scope] = {};
      if (on) map[scope][itemKey] = true;
      else delete map[scope][itemKey];
      if (Object.keys(map[scope]).length === 0) delete map[scope];
      write(map);
    },
    readScope(scope) {
      return new Set(Object.keys(read()[scope] ?? {}));
    },
  };
}
