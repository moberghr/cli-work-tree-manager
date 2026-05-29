import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { loadHistory, type WorktreeSession } from './history.js';
import { computeDiff } from './diff-pipeline.js';
import {
  disposeAllWatchers,
  findSession,
  sessionIdFor,
  subscribeSession,
} from './web-state.js';
import type { ParsedFile } from './diff-parse.js';

export interface WebServerHandle {
  url: string;
  port: number;
  stop: () => void;
}

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

function sessionToWire(s: WorktreeSession) {
  return {
    id: sessionIdFor(s),
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    paths: s.paths,
    baseBranch: s.baseBranch,
    jiraKey: s.jiraKey,
    createdAt: s.createdAt,
    lastAccessedAt: s.lastAccessedAt,
  };
}

/** Resolve the directory shipped by the Vite build. */
function resolveWebRoot(): string | null {
  // When bundled (dist/bin.js), the static assets live next to it as dist/web/.
  // process.argv[1] is the running entry script, so its dirname is dist/.
  const entryDir = path.dirname(process.argv[1] ?? '');
  const candidates = [
    path.join(entryDir, 'web'),
    // tsx/dev mode: walk up from src/core to repo root then into dist/web.
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

function serveStatic(root: string, urlPath: string, res: http.ServerResponse): boolean {
  // Map "/" → index.html. Strip query string.
  const clean = urlPath.split('?')[0];
  const requested = clean === '/' ? '/index.html' : clean;
  // Prevent directory traversal — resolve and ensure inside root.
  const filePath = path.join(root, requested);
  const norm = path.normalize(filePath);
  if (!norm.startsWith(path.normalize(root))) {
    return false;
  }
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

export interface RepoData {
  name: string;
  root: string;
  files: ParsedFile[];
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function computeSessionDiff(s: WorktreeSession): RepoData[] {
  return s.paths.map((p) => ({
    name: path.basename(p),
    root: p,
    files: computeDiff({ root: p, diffArg: 'HEAD' }),
  }));
}

/** All connected SSE clients. Used for fan-out of global events like
 *  sessions-changed. Each client may also have a session subscription
 *  attached as an unsubscribe handle on the response object. */
const sseClients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch { /* client gone */ }
  }
}

export function startWebServer(): Promise<WebServerHandle> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    return Promise.reject(
      new Error(
        'Could not find dist/web/. Run `npm run build:web` (or `npm run build`) first.',
      ),
    );
  }

  // Watch ~/.work/history.json so the sidebar reflects worktrees created
  // (or removed) by other terminals in real time. fs.watchFile (poll-based)
  // is more reliable cross-platform than fs.watch for a single file, and
  // chokidar would be overkill for one path.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const historyPath = path.join(home, '.work', 'history.json');
  const onHistoryChange = () => broadcast('sessions-changed', { ts: Date.now() });
  fs.watchFile(historyPath, { interval: 1000 }, onHistoryChange);

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://x');

    if (req.method === 'GET' && parsed.pathname === '/api/sessions') {
      const sessions = loadHistory().map(sessionToWire);
      sendJson(res, 200, { sessions });
      return;
    }

    const diffMatch = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/);
    if (req.method === 'GET' && diffMatch) {
      const id = diffMatch[1];
      const session = findSession(id);
      if (!session) {
        sendJson(res, 404, { error: 'unknown session' });
        return;
      }
      try {
        const repos = computeSessionDiff(session);
        sendJson(res, 200, { sessionId: id, repos });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      // Optional per-connection session subscription: client passes
      // ?session=<id> when it wants live diff updates for one session.
      const wantedSession = parsed.searchParams.get('session');
      let unsubscribe: (() => void) | null = null;
      if (wantedSession) {
        unsubscribe = subscribeSession(wantedSession, () => {
          try {
            res.write(
              `event: diff-changed\ndata: ${JSON.stringify({
                sessionId: wantedSession,
              })}\n\n`,
            );
          } catch { /* */ }
        });
      }

      const close = () => {
        sseClients.delete(res);
        if (unsubscribe) unsubscribe();
      };
      req.on('close', close);
      return;
    }

    // SPA fallback: anything not in /api/* and not a real file falls back
    // to index.html so client-side hash routing works on deep links.
    if (req.method === 'GET' && !parsed.pathname.startsWith('/api/')) {
      if (serveStatic(webRoot, parsed.pathname, res)) return;
      if (serveStatic(webRoot, '/index.html', res)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/`;
      process.stderr.write(chalk.gray(`[web] server listening at ${url}\n`));
      resolve({
        url,
        port,
        stop: () => {
          fs.unwatchFile(historyPath, onHistoryChange);
          disposeAllWatchers();
          for (const c of sseClients) {
            try { c.end(); } catch { /* */ }
          }
          sseClients.clear();
          server.close();
        },
      });
    });
  });
}
