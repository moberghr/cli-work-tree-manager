import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * What a global install gets: `dependencies` only. The CLI and server
 * (everything under src/ but the SPA) may import nothing else — a
 * devDependency there works in this repo and breaks every `npm i -g`. The
 * SPA is bundled by Vite into dist/web, so what only it uses belongs in
 * devDependencies: users would download it for nothing.
 */

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** The packages a set of files imports at runtime (type-only imports left out: they are erased). */
function packagesImported(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      if (/^\s*(?:import|export)\s+type\b/.test(m[0].trimStart())) continue;
      if (!found.has(packageOf(spec))) found.set(packageOf(spec), path.relative(ROOT, file));
    }
  }
  return found;
}

const all = walk(path.join(ROOT, 'src'));
const web = path.join(ROOT, 'src', 'web') + path.sep;
const nodeSide = packagesImported(all.filter((f) => !f.startsWith(web)));
const webSide = packagesImported(all.filter((f) => f.startsWith(web)));

describe('runtime dependencies', () => {
  it('the CLI and server import only `dependencies`', () => {
    const missing = [...nodeSide].filter(([name]) => !pkg.dependencies[name]).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });

  it('what only the SPA uses is a devDependency (Vite bundles it)', () => {
    const shipped = [...webSide.keys()].filter((name) => !nodeSide.has(name) && pkg.dependencies[name]);
    expect(shipped).toEqual([]);
  });

  it('every dependency is imported by the CLI or server', () => {
    const unused = Object.keys(pkg.dependencies).filter((name) => !nodeSide.has(name));
    expect(unused).toEqual([]);
  });

  it('a global install gets the versions CI tested: npm-shrinkwrap.json, published with the package, is the only lockfile', () => {
    expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(false); // npm would use the shrinkwrap anyway; two would drift
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm-shrinkwrap.json'), 'utf8')) as { name: string; version: string; packages: Record<string, { dependencies?: Record<string, string> }> };
    const pkgFull = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
    expect([lock.name, lock.version]).toEqual([pkgFull.name, pkgFull.version]);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies); // in step with package.json
    expect((pkgFull as { files?: string[] }).files).toContain('npm-shrinkwrap.json'); // with `files` set, npm packs only what it lists
  });
});
