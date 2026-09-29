import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

/**
 * Keep ~/.work/diffs/ from growing forever. It collects:
 *   - `<hash>.html`  — `wd --static` pages (self-contained, often MBs);
 *   - `<hash>.log`   — logs of the old per-scope diff daemons, which no
 *                      longer exist, so nothing writes these any more;
 *   - `<hash>.checkpoints.json` + `.lock` — live checkpoint manifests.
 *
 * Only the first two are disposable, and only once they're old: a static
 * page someone opened today must survive. Manifests and locks are never
 * touched here (work web sweeps checkpoints with their git refs).
 */

export const SWEEP_AFTER_DAYS = 30;
const DISPOSABLE = /\.(html|log)$/i;

export function sweepOldDiffArtifacts(
  now = Date.now(),
  maxAgeDays = SWEEP_AFTER_DAYS,
  dir = path.join(getConfigDir(), 'diffs'),
): { removed: number; bytes: number } {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    if (!DISPOSABLE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true });
      removed++;
      bytes += st.size;
    } catch {
      /* in use or gone — next start tries again */
    }
  }
  return { removed, bytes };
}
