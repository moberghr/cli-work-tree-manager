import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What a hook process loads. Claude runs `work hook <edge>` on every turn edge and `work hook statusline` on every
 * status-line refresh, of every Claude on the machine: each module they load at start is paid for each time. A heavy
 * module they need now and then is loaded with `import()` on first use (claude/hooks.ts's installer, claude/usage.ts's
 * status-line installer), which this graph leaves out on purpose — only what loads at start counts.
 */

const ROOT = path.resolve(__dirname, '../..');
// Static imports and re-exports; `import type` / `export type` are erased and left out.
const IMPORT_RE = /(?:^|\n)\s*(import|export)(\s+type)?\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g;
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Every local file and package `entry` loads at start. */
function loadedBy(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const abs = path.join(ROOT, file);
    for (const m of fs.readFileSync(abs, 'utf8').matchAll(IMPORT_RE)) {
      if (m[2]) continue;
      const spec = m[3]!;
      if (!spec.startsWith('.')) {
        if (!spec.startsWith('node:')) packages.add(spec);
        continue;
      }
      const base = path.resolve(path.dirname(abs), spec).replace(/\.js$/, '');
      const hit = ['.ts', '.tsx'].map((x) => base + x).find((f) => fs.existsSync(f));
      if (hit) visit(rel(hit));
    }
  };
  visit(entry);
  return { files, packages };
}

const SETTINGS_EDITOR = 'src/core/platform/settings-editor.ts';
const STATUSLINE_INSTALLER = 'src/core/agents/claude/statusline.ts';

describe('hook processes load little', () => {
  it('`work hook <edge>` loads neither the settings editor nor the status-line installer (the registry no longer re-exports them)', () => {
    const { files } = loadedBy('src/commands/hook.ts');
    expect(files.has('src/core/agents/index.ts')).toBe(true); // the walk does reach the registry
    expect(files.has(SETTINGS_EDITOR)).toBe(false);
    expect(files.has(STATUSLINE_INSTALLER)).toBe(false);
  });

  it('`work hook statusline` loads neither the registry, the settings editor, the CLI nor the database', () => {
    const { files, packages } = loadedBy('src/core/agents/claude/statusline-hook.ts');
    expect(files.has('src/core/agents/claude/statusline-run.ts')).toBe(true);
    // Not config.ts either (its validators, saved prompts, the Time tab's rules): the hook needs only ~/.work (config-dir.ts).
    for (const heavy of [
      'src/core/agents/index.ts',
      SETTINGS_EDITOR,
      STATUSLINE_INSTALLER,
      'src/core/platform/db.ts',
      'src/cli.ts',
      'src/core/platform/config.ts',
      'src/core/platform/report.ts',
    ])
      expect(files.has(heavy), heavy).toBe(false);
    for (const pkg of ['chalk', 'yargs', 'better-sqlite3']) expect(packages.has(pkg), pkg).toBe(false);
  });
});
