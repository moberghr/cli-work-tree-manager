import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../../../src/core/platform/package-root.js';

describe('packageRoot', () => {
  it('finds work’s own package.json by walking up, wherever the module sits', () => {
    const root = packageRoot();
    expect(root).toBe(path.resolve(__dirname, '../../..'));
    expect(JSON.parse(fs.readFileSync(path.join(root!, 'package.json'), 'utf8')).name).toBe('@moberg_hr/work-tree');
    expect(packageRoot()).toBe(root); // cached
  });
});
