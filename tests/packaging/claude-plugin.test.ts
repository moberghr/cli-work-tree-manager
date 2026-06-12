import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('claude plugin packaging', () => {
  const marketplace = JSON.parse(
    readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );

  it('marketplace manifest names the work-tree marketplace and plugin', () => {
    expect(marketplace.name).toBe('work-tree');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('work-tree');
  });

  it('marketplace plugin source directory exists with a valid plugin manifest', () => {
    const pluginDir = join(root, marketplace.plugins[0].source);
    const plugin = JSON.parse(
      readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(plugin.name).toBe('work-tree');
  });

  it('plugin ships the wd-review skill', () => {
    const skill = readFileSync(
      join(root, marketplace.plugins[0].source, 'skills', 'wd-review', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('name: wd-review');
  });

  it('npm package ships the postinstall script and plugin files', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.mjs');
    expect(pkg.files).toContain('scripts/postinstall.mjs');
    expect(pkg.files).toContain('.claude-plugin');
    expect(pkg.files).toContain('plugins');
    expect(existsSync(join(root, 'scripts', 'postinstall.mjs'))).toBe(true);
  });
});
