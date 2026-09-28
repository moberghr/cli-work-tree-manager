import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { glob } from 'tinyglobby';
import config from '../../tsup.config.js';

/**
 * Regression: `npm run build:server` used to delete dist/web/ (the SPA), so
 * `work web` failed with "Could not find dist/web/" until a full rebuild.
 * tsup cleans by deleting glob(['**\/*', ...clean]) in outDir — replicate
 * exactly that against the real config.
 */
describe('tsup clean keeps the Vite-built SPA', () => {
  it('a server-only build removes its own outputs but not dist/web/', async () => {
    const cfg = (Array.isArray(config) ? config[0] : config) as { clean?: boolean | string[] };
    const extra = Array.isArray(cfg.clean) ? cfg.clean : [];
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tsup-clean-'));
    for (const f of ['bin.js', 'bin.js.map', 'wd-bin.js', 'web/index.html', 'web/assets/app.js']) {
      fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
      fs.writeFileSync(path.join(out, f), 'x');
    }
    const doomed = await glob(['**/*', ...extra], { cwd: out, absolute: true });
    const rel = doomed.map((f) => path.relative(out, f).split(path.sep).join('/')).sort();
    expect(rel).toEqual(['bin.js', 'bin.js.map', 'wd-bin.js']);
    fs.rmSync(out, { recursive: true, force: true });
  });
});
