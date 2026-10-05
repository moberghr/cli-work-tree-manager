import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * work talks to coding agents through the adapter interface (agents/types.ts):
 * what is Claude Code's — its files, settings, protocols — lives in
 * src/core/agents/claude/, and only the registry (agents/index.ts) picks it
 * up. Anything else that imported it would be work knowing Claude by name,
 * and the next agent wouldn't get that feature.
 */

const ROOT = path.resolve(__dirname, '../..');
const CLAUDE_DIR = 'src/core/agents/claude/';
const REGISTRY = 'src/core/agents/index.ts';
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

describe('agents', () => {
  it("only the registry imports Claude's adapter: nothing else in work knows Claude by name", () => {
    const offenders: string[] = [];
    for (const abs of walk(path.join(ROOT, 'src'))) {
      const file = rel(abs);
      if (file.startsWith(CLAUDE_DIR) || file === REGISTRY) continue;
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec?.startsWith('.')) continue;
        const target = rel(path.resolve(path.dirname(abs), spec));
        if (target.startsWith(CLAUDE_DIR)) offenders.push(`${file} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Claude's adapter is self-contained: it imports work's core, never another agent's", () => {
    const others: string[] = [];
    for (const abs of walk(path.join(ROOT, CLAUDE_DIR))) {
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec?.startsWith('.')) continue;
        const target = rel(path.resolve(path.dirname(abs), spec));
        if (
          target.startsWith('src/core/agents/') &&
          !target.startsWith(CLAUDE_DIR) &&
          !/^src\/core\/agents\/(types|typing)\.js$/.test(target)
        )
          others.push(`${rel(abs)} → ${target}`);
      }
    }
    expect(others).toEqual([]);
  });
});
