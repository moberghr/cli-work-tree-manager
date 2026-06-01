import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { loadHistory, type WorktreeSession } from './history.js';
import { computeDiff } from './diff-pipeline.js';
import {
  disposeAllWatchers,
  findSession,
  sessionIdFor,
  subscribeSession,
} from './web-state.js';
import { resolveWebRoot, serveStaticOrShell } from './web-static.js';
import type { ParsedFile } from './diff-parse.js';

export interface WebServerHandle {
  url: string;
  port: number;
  stop: () => void;
}

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
  const home = os.homedir();
  const historyPath = path.join(home, '.work', 'history.json');
  const onHistoryChange = () => broadcast('sessions-changed', { ts: Date.now() });
  fs.watchFile(historyPath, { interval: 1000 }, onHistoryChange);

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://x');

    if (req.method === 'GET' && parsed.pathname === '/api/context') {
      sendJson(res, 200, { mode: 'dashboard' });
      return;
    }

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
      if (serveStaticOrShell(webRoot, parsed.pathname, res)) return;
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
