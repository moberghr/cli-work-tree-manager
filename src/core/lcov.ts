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

/** Normalize a path for comparison: forward slashes, drop a leading `./`. */
function normRel(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Read and parse the repo's lcov (if any) and return a map of repo-relative
 * path → line-coverage percent for the requested files only. lcov `SF:` paths
 * may be absolute or relative; both sides are normalized to repo-relative and
 * compared. Entries are only included on a confident path match.
 */
export function coverageForFiles(
  root: string,
  relPaths: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const lcovPath = findLcov(root);
  if (!lcovPath) return out;

  let content: string;
  try {
    content = fs.readFileSync(lcovPath, 'utf-8');
  } catch {
    return out;
  }

  const parsed = parseLcov(content);
  if (parsed.size === 0) return out;

  // Build a lookup keyed by normalized repo-relative SF path.
  const normRoot = path.resolve(root);
  const byRel = new Map<string, number>();
  for (const [sf, pct] of parsed) {
    let rel: string;
    if (path.isAbsolute(sf)) {
      rel = path.relative(normRoot, path.resolve(sf));
    } else {
      rel = sf;
    }
    byRel.set(normRel(rel), pct);
  }

  for (const rp of relPaths) {
    const pct = byRel.get(normRel(rp));
    if (typeof pct === 'number') out.set(rp, pct);
  }

  return out;
}
