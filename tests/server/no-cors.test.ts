import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What keeps a page that isn't ours — another site, or a session's shown HTML in its sandbox — from reading work web's
 * answers is that no answer allows it: the browser hides a cross-origin response unless it carries CORS headers. So none
 * of our servers sends one (§1.5c).
 */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('no CORS', () => {
  it('no server or core module sends Access-Control-Allow-* headers, nor uses a CORS middleware', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders = [...sources(path.join(root, 'src/server')), ...sources(path.join(root, 'src/core'))].filter((f) =>
      /Access-Control-Allow-|hono\/cors|from ['"]cors['"]/i.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
