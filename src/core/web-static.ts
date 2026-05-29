import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve the directory shipped by the Vite build. */
export function resolveWebRoot(): string | null {
  const entryDir = path.dirname(process.argv[1] ?? '');
  const candidates = [
    path.join(entryDir, 'web'),
    // dev/tsx fallback: walk up from src/core to repo root then into dist/web.
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

/**
 * Serve a static file under `root`. Returns true if it served a file. Does
 * NOT do SPA fallback — caller decides whether to re-try with /index.html
 * on miss.
 */
export function serveStatic(
  root: string,
  urlPath: string,
  res: http.ServerResponse,
): boolean {
  const clean = urlPath.split('?')[0];
  const requested = clean === '/' ? '/index.html' : clean;
  const filePath = path.join(root, requested);
  const norm = path.normalize(filePath);
  if (!norm.startsWith(path.normalize(root))) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(norm);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(norm).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(norm).pipe(res);
  return true;
}

/** Convenience: serve the file if it exists, else fall back to index.html. */
export function serveStaticOrShell(
  root: string,
  urlPath: string,
  res: http.ServerResponse,
): boolean {
  if (serveStatic(root, urlPath, res)) return true;
  if (serveStatic(root, '/index.html', res)) return true;
  return false;
}
