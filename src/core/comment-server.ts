import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import chalk from 'chalk';
import chokidar from 'chokidar';
import { computeDiff } from './diff-pipeline.js';
import { resolveWebRoot, serveStaticOrShell } from './web-static.js';
import type { RepoSpec } from './diff-watcher.js';

export type CommentAuthor = 'user' | 'claude';
export type CommentStatus = 'published' | 'draft';

export interface Comment {
  id: string;
  /** Empty for general comments not tied to a specific repo. */
  repo: string;
  /** Empty for general comments. */
  file: string;
  /** 0 for general comments. */
  line: number;
  /** 'general' for non-line-specific comments. */
  side: 'left' | 'right' | 'general';
  body: string;
  createdAt: string;
  /** Raw content of the diff line at the time the comment was made. Used to
   *  detect "outdated" comments after the underlying file changes. */
  lineContent?: string;
  /** 'user' for comments authored in the browser, 'claude' for replies
   *  posted by the assistant via the same /api/comments endpoint. */
  author: CommentAuthor;
  /** If set, this comment is a reply to the comment with this id. */
  parentId?: string;
  /** 'published' streams to stdout immediately; 'draft' is held until the
   *  user submits the review batch via POST /api/submit-review. */
  status: CommentStatus;
}

export interface CommentServerOptions {
  /** Repos this review session covers (1 for single, N for group). */
  repos: RepoSpec[];
  /** Short human-readable label shown in the page title and /api/context. */
  scopeLabel: string;
  /** Fires once per *published* user comment. Drafts are silent until submitted. */
  onComment?: (comment: Comment) => void;
  /** Called when the user deletes a comment. */
  onCommentDeleted?: (id: string) => void;
  /** Fires before the per-comment onComment events when a review batch is submitted. */
  onSubmitReviewStart?: (info: { count: number; summary: Comment | null }) => void;
  /** Fires after the batch has finished streaming. */
  onSubmitReviewEnd?: () => void;
  /** Debounce for fs.watch events before broadcasting diff-changed. */
  watchDebounceMs?: number;
}

export interface CommentServerHandle {
  url: string;
  waitForDone(): Promise<Comment[]>;
  snapshot(): Comment[];
  stop(): void;
}

/**
 * Local HTTP server that powers `wd -c`. Serves the React SPA shell from /,
 * exposes /api/context (mode + scope), /api/diff (live RepoData[] for the
 * current scope), /api/comments and friends, plus SSE for diff-changed and
 * the comment lifecycle. Owns its own chokidar watcher so file edits push
 * diff-changed without the caller having to wire it.
 */
export function startCommentServer(
  opts: CommentServerOptions,
): Promise<CommentServerHandle> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    return Promise.reject(
      new Error(
        'Could not find dist/web/. Run `npm run build` first.',
      ),
    );
  }

  const debounceMs = opts.watchDebounceMs ?? 150;
  const comments: Comment[] = [];
  const sseClients = new Set<http.ServerResponse>();
  let resolveDone: ((comments: Comment[]) => void) | null = null;
  const donePromise = new Promise<Comment[]>((resolve) => {
    resolveDone = resolve;
  });

  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch { /* */ }
    }
  }

  // Chokidar over every repo root in the scope. The browser refetches
  // /api/diff when it sees a diff-changed event.
  const watchRoots = opts.repos.map((r) => r.root);
  let debounceTimer: NodeJS.Timeout | null = null;
  const watcher = chokidar.watch(watchRoots, {
    ignored: (filePath) => {
      for (const r of opts.repos) {
        const rel = path.relative(r.root, filePath).replace(/\\/g, '/');
        if (rel === '.git' || rel.startsWith('.git/')) return true;
      }
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });
  watcher.on('all', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcast('diff-changed', { ts: Date.now() });
    }, debounceMs);
  });
  watcher.on('error', (err) => {
    process.stderr.write(
      chalk.yellow('[review] fs watcher error: ') + (err as Error).message + '\n',
    );
  });

  function sendJson(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(body));
  }

  function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://x');

    if (req.method === 'GET' && parsed.pathname === '/api/context') {
      sendJson(res, 200, {
        mode: 'review',
        scopeLabel: opts.scopeLabel,
        repos: opts.repos.map((r) => ({ name: r.name })),
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/diff') {
      try {
        const repos = opts.repos.map((r) => ({
          name: r.name,
          root: r.root,
          files: computeDiff({ root: r.root, diffArg: r.diffArg }),
        }));
        sendJson(res, 200, { repos });
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
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/comments') {
      sendJson(res, 200, { comments });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/comments') {
      try {
        const body = (await readJsonBody(req)) as Partial<Comment>;
        if (typeof body.body !== 'string' || !body.body.trim()) {
          sendJson(res, 400, { error: 'comment body is required' });
          return;
        }
        let parent: Comment | undefined;
        if (typeof body.parentId === 'string') {
          parent = comments.find((c) => c.id === body.parentId);
          if (!parent) {
            sendJson(res, 400, { error: 'parent comment not found' });
            return;
          }
        }
        const repo =
          (typeof body.repo === 'string' ? body.repo : parent?.repo) ?? '';
        const file =
          (typeof body.file === 'string' ? body.file : parent?.file) ?? '';
        const line =
          typeof body.line === 'number' ? body.line : (parent?.line ?? 0);
        const side = body.side ?? parent?.side ?? 'general';
        if (side !== 'left' && side !== 'right' && side !== 'general') {
          sendJson(res, 400, { error: 'invalid side' });
          return;
        }
        const author: CommentAuthor =
          body.author === 'claude' ? 'claude' : 'user';
        const status: CommentStatus =
          body.status === 'draft' ? 'draft' : 'published';
        const c: Comment = {
          id: crypto.randomBytes(8).toString('hex'),
          repo,
          file,
          line,
          side,
          body: body.body.trim(),
          createdAt: new Date().toISOString(),
          lineContent:
            typeof body.lineContent === 'string'
              ? body.lineContent
              : parent?.lineContent,
          author,
          parentId: parent?.id,
          status,
        };
        comments.push(c);
        if (status === 'published' && author === 'user' && opts.onComment) {
          opts.onComment(c);
        }
        if (author === 'claude') broadcast('comments-changed', { id: c.id });
        sendJson(res, 200, { comment: c, comments });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    const deleteMatch = parsed.pathname.match(/^\/api\/comments\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = deleteMatch[1];
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) {
        comments.splice(idx, 1);
        if (opts.onCommentDeleted) opts.onCommentDeleted(id);
      }
      sendJson(res, 200, { comments });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/submit-review') {
      try {
        const body = (await readJsonBody(req)) as { summary?: string };
        const drafts = comments
          .filter((c) => c.status === 'draft')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let summaryComment: Comment | null = null;
        if (typeof body.summary === 'string' && body.summary.trim()) {
          summaryComment = {
            id: crypto.randomBytes(8).toString('hex'),
            repo: '',
            file: '',
            line: 0,
            side: 'general',
            body: body.summary.trim(),
            createdAt: new Date().toISOString(),
            author: 'user',
            status: 'published',
          };
          comments.push(summaryComment);
        }
        if (opts.onSubmitReviewStart) {
          opts.onSubmitReviewStart({ count: drafts.length, summary: summaryComment });
        }
        if (summaryComment && opts.onComment) opts.onComment(summaryComment);
        for (const d of drafts) {
          d.status = 'published';
          if (opts.onComment) opts.onComment(d);
        }
        if (opts.onSubmitReviewEnd) opts.onSubmitReviewEnd();
        sendJson(res, 200, { count: drafts.length, comments });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/discard-review') {
      const before = comments.length;
      for (let i = comments.length - 1; i >= 0; i--) {
        if (comments[i].status === 'draft') comments.splice(i, 1);
      }
      const removed = before - comments.length;
      sendJson(res, 200, { discarded: removed, comments });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/done') {
      sendJson(res, 200, { ok: true, count: comments.length });
      if (resolveDone) {
        resolveDone([...comments]);
        resolveDone = null;
      }
      return;
    }

    // SPA shell + assets, fallback for client-side routing.
    if (req.method === 'GET' && !parsed.pathname.startsWith('/api/')) {
      if (serveStaticOrShell(webRoot, parsed.pathname, res)) return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/`;
      process.stderr.write(chalk.gray(`[review] server listening at ${url}\n`));
      resolve({
        url,
        waitForDone: () => donePromise,
        snapshot: () => [...comments],
        stop: () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          watcher.close().catch(() => { /* */ });
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

/**
 * Format a single comment as a markdown chunk suitable for streaming. Each
 * chunk is self-describing — file, line, side, body — so a reader (Claude
 * or a human) can act on just one without seeing the rest.
 */
export function formatSingleComment(c: Comment): string {
  const bodyLines = c.body.split('\n').map((l) => `> ${l}`).join('\n');
  const header =
    c.side === 'general'
      ? `**General review comment**`
      : `**${c.repo}/${c.file}** : line ${c.line} (${c.side})`;
  const meta: string[] = [];
  if (c.author === 'claude') meta.push('author: claude');
  if (c.parentId) meta.push(`reply-to: ${c.parentId}`);
  meta.push(`id: ${c.id}`);
  return [`--- comment ---`, header, meta.join(' · '), bodyLines, ``].join('\n');
}

/**
 * Format the comment set as markdown for stdout. Grouped by file. Currently
 * unused (each comment streams individually via formatSingleComment); kept
 * for possible future use cases.
 */
export function formatCommentsMarkdown(comments: Comment[]): string {
  if (comments.length === 0) {
    return 'No review comments.';
  }
  const byFile = new Map<string, Comment[]>();
  for (const c of comments) {
    const key = `${c.repo}/${c.file}`;
    const arr = byFile.get(key) ?? [];
    arr.push(c);
    byFile.set(key, arr);
  }
  const sortedFiles = Array.from(byFile.keys()).sort();
  const sections = sortedFiles.map((file) => {
    const items = byFile
      .get(file)!
      .sort((a, b) => a.line - b.line)
      .map((c) => {
        const bodyLines = c.body
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        return `### Line ${c.line} (${c.side} side)\n${bodyLines}`;
      })
      .join('\n\n');
    return `## ${file}\n\n${items}`;
  });
  return [
    `# Review comments (${comments.length})`,
    '',
    sections.join('\n\n'),
  ].join('\n');
}
