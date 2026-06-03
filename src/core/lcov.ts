import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse standard lcov.info content into a map of file path → line-coverage
 * percent (a float in [0, 100]). Keys are the `SF:` paths exactly as written
 * in the file (may be absolute or repo-relative depending on the tool).
 *
 * Per-file percent prefers the `LF`/`LH` summary lines (lines found / lines
 * hit) when present; otherwise it is derived from the individual `DA:` line
 * records (`DA:<line>,<hits>`). A file with zero lines found yields 0.
 */
export function parseLcov(content: string): Map<string, number> {
  const result = new Map<string, number>();

  let sf: string | null = null;
  let lf: number | null = null;
  let lh: number | null = null;
  let daTotal = 0;
  let daHit = 0;

  const finish = () => {
    if (sf === null) return;
    let pct: number;
    if (lf !== null && lf > 0) {
      pct = ((lh ?? 0) / lf) * 100;
    } else if (lf === 0) {
      pct = 0;
    } else if (daTotal > 0) {
      pct = (daHit / daTotal) * 100;
    } else {
      pct = 0;
    }
    result.set(sf, pct);
  };

  const reset = () => {
    sf = null;
    lf = null;
    lh = null;
    daTotal = 0;
    daHit = 0;
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      sf = line.slice(3).trim();
    } else if (line.startsWith('DA:')) {
      const rest = line.slice(3);
      const comma = rest.indexOf(',');
      if (comma !== -1) {
        const hits = Number(rest.slice(comma + 1).split(',')[0]);
        if (Number.isFinite(hits)) {
          daTotal += 1;
          if (hits > 0) daHit += 1;
        }
      }
    } else if (line.startsWith('LF:')) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) lf = n;
    } else if (line.startsWith('LH:')) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) lh = n;
    } else if (line === 'end_of_record') {
      finish();
      reset();
    }
  }
  // Tolerate a trailing record with no terminating `end_of_record`.
  finish();

  return result;
}

/**
 * Locate an lcov.info file for a repo root. Checks `<root>/coverage/lcov.info`
 * then `<root>/lcov.info`. Returns the first that exists, else null.
 */
export function findLcov(root: string): string | null {
  const candidates = [
    path.join(root, 'coverage', 'lcov.info'),
    path.join(root, 'lcov.info'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // not present — try next
    }
  }
  return null;
}

/**
 * Cache of parsed lcov files keyed by absolute lcov path. `computeDiff` runs
 * on every SSE / chokidar tick; an lcov.info can be multiple MB, so we MUST
 * NOT re-read + re-parse it each refresh. The cache is invalidated when the
 * file's `mtimeMs` changes (a fresh `npm test -- --coverage` run rewrites it).
 */
interface LcovCacheEntry {
  mtimeMs: number;
  parsed: Map<string, number>;
}
const lcovCache = new Map<string, LcovCacheEntry>();

/**
 * Read + parse the lcov at `lcovPath`, memoizing by `(path, mtimeMs)`. Returns
 * the parsed `SF: → percent` map and the lcov's mtime (ms-since-epoch), or
 * null when the file can't be stat'd / read. A multi-MB lcov is parsed once
 * and reused until it is rewritten.
 *
 * Exported for testing the cache behavior.
 */
export function readParsedLcov(
  lcovPath: string,
): { parsed: Map<string, number>; mtimeMs: number } | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lcovPath).mtimeMs;
  } catch {
    lcovCache.delete(lcovPath);
    return null;
  }

  const cached = lcovCache.get(lcovPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { parsed: cached.parsed, mtimeMs };
  }

  let content: string;
  try {
    content = fs.readFileSync(lcovPath, 'utf-8');
  } catch {
    lcovCache.delete(lcovPath);
    return null;
  }

  const parsed = parseLcov(content);
  lcovCache.set(lcovPath, { mtimeMs, parsed });
  return { parsed, mtimeMs };
}

/** Test hook: drop the in-memory parse cache. */
export function clearLcovCache(): void {
  lcovCache.clear();
}

/** Normalize a path for comparison: forward slashes, drop a leading `./`. */
function normRel(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Canonicalize `root` once so SF:-path matching survives symlink / realpath
 * divergence (macOS `/tmp` → `/private/tmp`, Linux bind mounts, Windows
 * junctions) and case-insensitive filesystems. An absolute `SF:` path emitted
 * by the coverage tool is resolved through `realpath` too, so both sides share
 * a canonical namespace before `path.relative` runs — otherwise the relative
 * path comes out `..`-prefixed and the match is silently lost.
 */
function realRoot(root: string): string {
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

/**
 * Canonicalize an absolute path by realpath-ing its deepest EXISTING ancestor
 * and re-appending the not-yet-existing tail. `fs.realpathSync(absSf)` throws
 * when the leaf doesn\'t exist on disk (lcov records files that may since have
 * moved, or simply aren\'t present in a sparse checkout); a plain
 * `path.resolve` fallback would leave the path in a different symlink
 * namespace from `canonRoot` (macOS `/var/folders` TMPDIR, etc.) and the
 * relative path would come out `..`-prefixed — silently dropping the match.
 * Resolving the existing prefix keeps both sides in one canonical namespace.
 */
function canonicalize(absPath: string): string {
  const resolved = path.resolve(absPath);
  let dir = resolved;
  const tail: string[] = [];
  // Walk up until we hit a path that exists (realpath-able) or the root.
  for (;;) {
    try {
      const realDir = fs.realpathSync(dir);
      return tail.length ? path.join(realDir, ...tail.reverse()) : realDir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved; // reached fs root, nothing realpath-able
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** Resolve an absolute `SF:` path to repo-relative against the canonical root,
 *  following symlinks (even when the leaf file is absent) so realpath
 *  divergence and case-insensitive filesystems don\'t break the match. */
function relForAbsSf(absSf: string, canonRoot: string): string {
  return path.relative(canonRoot, canonicalize(absSf));
}

/**
 * Result of a per-repo coverage lookup. `byPath` maps each requested
 * repo-relative path that matched to its line-coverage percent. `lcovMtimeMs`
 * is the mtime of the lcov.info the data came from (so callers can surface
 * staleness), or null when no lcov was found.
 */
export interface CoverageLookup {
  byPath: Map<string, number>;
  lcovMtimeMs: number | null;
}

/**
 * Read and parse the repo's lcov (if any) and return a map of repo-relative
 * path → line-coverage percent for the requested files only, plus the lcov
 * mtime. lcov `SF:` paths may be absolute or relative; both sides are
 * normalized to a canonical repo-relative path and compared. Entries are only
 * included on a confident path match.
 *
 * The underlying lcov parse is memoized by `(path, mtimeMs)` (see
 * `readParsedLcov`) so a multi-MB file isn't re-read on every diff refresh.
 */
export function coverageLookup(
  root: string,
  relPaths: string[],
): CoverageLookup {
  const out = new Map<string, number>();
  const lcovPath = findLcov(root);
  if (!lcovPath) return { byPath: out, lcovMtimeMs: null };

  const read = readParsedLcov(lcovPath);
  if (!read || read.parsed.size === 0) {
    return { byPath: out, lcovMtimeMs: read?.mtimeMs ?? null };
  }

  // Build a lookup keyed by normalized repo-relative SF path.
  const canonRoot = realRoot(root);
  const byRel = new Map<string, number>();
  for (const [sf, pct] of read.parsed) {
    const rel = path.isAbsolute(sf) ? relForAbsSf(sf, canonRoot) : sf;
    byRel.set(normRel(rel), pct);
  }

  for (const rp of relPaths) {
    const pct = byRel.get(normRel(rp));
    if (typeof pct === 'number') out.set(rp, pct);
  }

  return { byPath: out, lcovMtimeMs: read.mtimeMs };
}

/**
 * Back-compat thin wrapper: returns just the `repo-relative path → percent`
 * map (drops the lcov mtime). Prefer `coverageLookup` when you need staleness
 * information.
 */
export function coverageForFiles(
  root: string,
  relPaths: string[],
): Map<string, number> {
  return coverageLookup(root, relPaths).byPath;
}
