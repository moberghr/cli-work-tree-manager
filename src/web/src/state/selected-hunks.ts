/**
 * Per-browser tracking of which individual diff hunks in a review/scope
 * have been checked off by the reviewer. Survives reload via localStorage.
 * Each scope (a wd -c review or a session in the dashboard) gets its own
 * bucket so selection doesn't leak across worktrees.
 *
 * Mirrors the per-file "viewed" machinery in viewed-files.ts exactly — the
 * only differences are the storage KEY and that the inner key is a hunk
 * key (`${filePath}@${oldStart}-${newStart}`) instead of a file path.
 *
 * Storage shape: { [scopeKey]: { [hunkKey]: true } }
 */
const KEY = 'work-web:selected-hunks';

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

export function isSelected(scope: string, hunkKey: string): boolean {
  return !!read()[scope]?.[hunkKey];
}

export function setSelected(
  scope: string,
  hunkKey: string,
  selected: boolean,
): void {
  const map = read();
  if (!map[scope]) map[scope] = {};
  if (selected) map[scope][hunkKey] = true;
  else delete map[scope][hunkKey];
  if (Object.keys(map[scope]).length === 0) delete map[scope];
  write(map);
}

export function readScope(scope: string): Set<string> {
  return new Set(Object.keys(read()[scope] ?? {}));
}
