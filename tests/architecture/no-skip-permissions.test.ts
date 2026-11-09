import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, rel } from './source-scan.js';

/**
 * work never starts an agent with its permission checks off: `--unsafe` was
 * retired, and every agent starts in its own permission mode (Claude Code's
 * auto mode, its allow rules — the user's choice, made in the agent). So the
 * flag that turned them off appears nowhere in what work ships: not in code,
 * not in a comment that might be copied back, not in the skills it hands to
 * agents.
 */

const FLAG = /dangerously-skip-permissions/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...walk(p));
    } else if (/\.(tsx?|mjs|js|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no skip-permissions flag anywhere work ships', () => {
  it('src/, plugins/ and scripts/ never name it', () => {
    const files = ['src', 'plugins', 'scripts'].flatMap((d) => walk(path.join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => FLAG.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });
});
