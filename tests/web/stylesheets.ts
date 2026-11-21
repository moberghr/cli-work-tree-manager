import fs from 'node:fs';
import path from 'node:path';

/**
 * Every stylesheet the dashboard loads, in the order main.tsx imports them, joined: the shared ones, the pieces'
 * (ui/ui.css) and each page's own (styles/pages/). A test that reads a rule reads it from here, so it keeps
 * finding it when the rule moves to its page's stylesheet.
 */
export function allStylesheets(): string {
  const src = path.join(__dirname, '../../src/web/src');
  const main = fs.readFileSync(path.join(src, 'main.tsx'), 'utf8');
  const files = [...main.matchAll(/^import '\.\/([^']+\.css)';$/gm)].map((m) => m[1]);
  return files.map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
}
