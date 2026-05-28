import http from 'node:http';
import crypto from 'node:crypto';
import chalk from 'chalk';

export type CommentAuthor = 'user' | 'claude';

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
}

export interface CommentServerOptions {
  /** Full rendered HTML (with comment UI included). Re-served on every GET. */
  html: string;
  /** Called every time a new comment is POSTed by the browser. Used by the
   *  caller to stream comments to stdout as they arrive. */
  onComment?: (comment: Comment) => void;
  /** Called when the user deletes a comment. */
  onCommentDeleted?: (id: string) => void;
}

export interface CommentServerHandle {
  url: string;
  /** Resolves with the final comment set when the user clicks Done or
   *  Ctrl+C is pressed (handled by the caller). */
  waitForDone(): Promise<Comment[]>;
  /** Snapshot current comments without waiting. */
  snapshot(): Comment[];
  /** Swap in freshly-rendered HTML and push a reload event to all browsers. */
  update(html: string): void;
  stop(): void;
}

/**
 * Tiny review-mode HTTP server. Serves the rendered diff HTML at `/`, accepts
 * comment add/delete via JSON endpoints, and resolves the calling promise
 * when the user clicks "Done" in the browser.
 *
 * Synchronous review flow: caller awaits `waitForDone()` → returns when the
 * browser POSTs /api/done → caller formats + prints comments → exits.
 */
export function startCommentServer(
  opts: CommentServerOptions,
): Promise<CommentServerHandle> {
  const comments: Comment[] = [];
  let currentHtml = opts.html;
  const sseClients = new Set<http.ServerResponse>();
  let resolveDone: ((comments: Comment[]) => void) | null = null;
  const donePromise = new Promise<Comment[]>((resolve) => {
    resolveDone = resolve;
  });

  function broadcastReload() {
    for (const res of sseClients) {
      try {
        res.write(`event: reload\ndata: ${Date.now()}\n\n`);
      } catch {
        /* client disconnected */
      }
    }
  }

  function send(res: http.ServerResponse, status: number, body: unknown) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type':
        typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store',
      // Allow file:// origin and any localhost origin to POST.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(json);
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
      send(res, 204, '');
      return;
    }
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      send(res, 200, currentHtml);
      return;
    }

    if (req.method === 'GET' && url === '/events') {
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

    if (req.method === 'GET' && url === '/api/comments') {
      send(res, 200, { comments });
      return;
    }

    if (req.method === 'POST' && url === '/api/comments') {
      try {
        const body = (await readJsonBody(req)) as Partial<Comment>;
        if (typeof body.body !== 'string' || !body.body.trim()) {
          send(res, 400, { error: 'comment body is required' });
          return;
        }
        // Replies inherit anchor info from their parent so the caller
        // only needs to supply { body, parentId, author }.
        let parent: Comment | undefined;
        if (typeof body.parentId === 'string') {
          parent = comments.find((c) => c.id === body.parentId);
          if (!parent) {
            send(res, 400, { error: 'parent comment not found' });
            return;
          }
        }
        const repo =
          (typeof body.repo === 'string' ? body.repo : parent?.repo) ?? '';
        const file =
          (typeof body.file === 'string' ? body.file : parent?.file) ?? '';
        const line =
          typeof body.line === 'number' ? body.line : (parent?.line ?? 0);
        const side =
          body.side ?? parent?.side ?? 'general';
        if (side !== 'left' && side !== 'right' && side !== 'general') {
          send(res, 400, { error: 'invalid side' });
          return;
        }
        const author: CommentAuthor =
          body.author === 'claude' ? 'claude' : 'user';
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
        };
        comments.push(c);
        if (opts.onComment) opts.onComment(c);
        send(res, 200, { comment: c, comments });
      } catch {
        send(res, 400, { error: 'bad request' });
      }
      return;
    }

    const deleteMatch = url.match(/^\/api\/comments\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = deleteMatch[1];
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) {
        comments.splice(idx, 1);
        if (opts.onCommentDeleted) opts.onCommentDeleted(id);
      }
      send(res, 200, { comments });
      return;
    }

    if (req.method === 'POST' && url === '/api/done') {
      send(res, 200, { ok: true, count: comments.length });
      if (resolveDone) {
        resolveDone([...comments]);
        resolveDone = null;
      }
      return;
    }

    send(res, 404, { error: 'not found' });
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
        update: (newHtml: string) => {
          currentHtml = newHtml;
          broadcastReload();
        },
        stop: () => {
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
 * Format the comment set as markdown for stdout. Grouped by file, with each
 * comment as a quoted block. Designed to be readable by a human and pasted
 * straight back into an LLM conversation.
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
