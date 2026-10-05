import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder of work's own package.json — the installed package, or this
 * repo in dev. Found by walking up from this module, so it holds wherever
 * the code sits: bundled into dist/ (a chunk next to bin.js) or a source
 * file several folders under src/. Files shipped beside dist/ (dist/web, the
 * skills under plugins/) are found from here, never by counting `..`.
 */
let cached: string | null | undefined;
export function packageRoot(): string | null {
  if (cached !== undefined) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === '@moberg_hr/work-tree') return (cached = dir);
    } catch {
      /* none here */
    }
    const up = path.dirname(dir);
    if (up === dir) return (cached = null);
    dir = up;
  }
}
