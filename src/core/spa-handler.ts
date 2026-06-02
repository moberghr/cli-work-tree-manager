import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

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

function readFile(root: string, relPath: string): { body: Buffer; ext: string } | null {
  const clean = relPath.split('?')[0];
  const requested = clean === '/' ? '/index.html' : clean;
  const filePath = path.join(root, requested);
  const norm = path.normalize(filePath);
  if (!norm.startsWith(path.normalize(root))) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(norm);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const ext = path.extname(norm).toLowerCase();
  return { body: fs.readFileSync(norm), ext };
}

/**
 * Hono handler for the bundled SPA. Tries to serve the requested file; if it
 * doesn't exist, falls back to index.html so client-side routing works on
 * deep links. Skips /api/* paths entirely (those should be handled by
 * earlier routes; if we reach here it's a 404).
 */
export function serveSpa(c: Context, webRoot: string): Response {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) {
    return c.json({ error: 'not found' }, 404);
  }
  const hit = readFile(webRoot, url.pathname) ?? readFile(webRoot, '/index.html');
  if (!hit) return c.json({ error: 'not found' }, 404);
  return new Response(new Uint8Array(hit.body), {
    status: 200,
    headers: {
      'Content-Type': MIME[hit.ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
