import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Dependency-graph rules (companion to boundaries.test.ts): the shape of
 * the import graph itself, not just who may import what.
 */

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

/** file → the local files it imports (resolved, with .ts/.tsx). */
const graph = new Map<string, string[]>();
for (const abs of walk(SRC)) {
  const text = fs.readFileSync(abs, 'utf-8');
  const deps: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(abs), spec).replace(/\.js$/, '');
    const hit = ['.ts', '.tsx'].map((x) => base + x).find((f) => fs.existsSync(f));
    if (hit) deps.push(rel(hit));
  }
  graph.set(rel(abs), deps);
}

describe('dependency graph', () => {
  it('has no import cycles (type-only ones included — they still couple modules)', () => {
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: string[][] = [];
    const visit = (v: string) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      for (const w of graph.get(v) ?? []) {
        if (!graph.has(w)) continue;
        if (!idx.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) cycles.push(scc.sort());
      }
    };
    for (const v of graph.keys()) if (!idx.has(v)) visit(v);
    expect(cycles).toEqual([]);
  });

  it('commands never import other commands — shared code lives in commands/shared/, core/ or utils/', () => {
    const offenders: string[] = [];
    for (const [file, deps] of graph) {
      if (!file.startsWith('src/commands/') || file.startsWith('src/commands/shared/')) continue;
      for (const d of deps) {
        if (d.startsWith('src/commands/') && !d.startsWith('src/commands/shared/')) offenders.push(`${file} → ${d}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('utils/ is a leaf layer: it may use core types but never commands', () => {
    const offenders = [...graph]
      .filter(([f]) => f.startsWith('src/utils/'))
      .flatMap(([f, deps]) => deps.filter((d) => d.startsWith('src/commands/')).map((d) => `${f} → ${d}`));
    expect(offenders).toEqual([]);
  });
});
