#!/usr/bin/env node
// Best-effort: give each agent work knows its skills (work-sessions,
// wd-review) — `work install-skills`, i.e. src/core/skills.ts, where each
// agent's adapter does it its own way (Claude Code: register the work-tree
// plugin marketplace and install the plugin). Never fails the npm install —
// every step is optional.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function main() {
  if (process.env.CI || process.env.WORK_TREE_SKIP_PLUGIN_SETUP) return;
  // The built CLI next to this script; absent in a fresh clone before `npm run build` — nothing to do yet.
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
  if (!existsSync(bin)) return;
  // argv only, no shell: nothing user-controlled reaches a command line.
  spawnSync(process.execPath, [bin, 'install-skills'], { stdio: 'inherit', timeout: 180_000, windowsHide: true });
}

try {
  main();
} catch {
  // Never break npm install over optional skill setup.
}
