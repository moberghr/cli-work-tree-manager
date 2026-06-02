/**
 * Per-browser tracking of which files in a review/scope have been marked
 * "viewed". Survives reload via localStorage. Each scope (a wd -c review or
 * a session in the dashboard) gets its own bucket so files don't leak
 * across worktrees.
 *
 * Storage shape: { [scopeKey]: { [filePath]: true } }
 */
const KEY = 'work-web:viewed-files';

type ScopeMap = Record<string, Record<string, boolean>>;

function read(): ScopeMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ScopeMap) : {};
  } catch {
    return {};
  }
}

function write(map: ScopeMap): void {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* */ }
}

export function isViewed(scope: string, filePath: string): boolean {
  return !!read()[scope]?.[filePath];
}

export function setViewed(
  scope: string,
  filePath: string,
  viewed: boolean,
): void {
  const map = read();
  if (!map[scope]) map[scope] = {};
  if (viewed) map[scope][filePath] = true;
  else delete map[scope][filePath];
  if (Object.keys(map[scope]).length === 0) delete map[scope];
  write(map);
}

export function readScope(scope: string): Set<string> {
  return new Set(Object.keys(read()[scope] ?? {}));
}
