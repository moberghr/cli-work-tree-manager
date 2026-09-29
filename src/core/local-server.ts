import chalk from 'chalk';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { refuseReason } from './local-origin.js';

// The one way to start a local HTTP server (work web, wd, the comment
// server, the demo): 127.0.0.1 only, random port, behind the Host/Origin
// guard. Its own module so a server that needs no git/fs — the demo — can
// use it without importing the diff server.

export interface DiffServerHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** Start a Hono app on a random port; resolve when it's listening. The
 *  raw Node server is exposed via `httpServer` so callers can attach
 *  WebSocket upgrade handlers (the terminal bridge).
 *
 *  Installs a guard (core/local-origin.ts): Host must be ours (DNS
 *  rebinding), and mutating requests must not come from another origin
 *  (cross-site request forgery from any page open in the browser). The SPA
 *  is served same-origin, and Node callers send no Origin, so both pass.
 */
export function launch(app: Hono): Promise<DiffServerHandle & { httpServer: ServerType }> {
  return new Promise((resolve) => {
    // Captured before serve() resolves; first guarded request runs after
    // this is set because serve() doesn't accept connections until it's
    // bound, and bind precedes the info-callback.
    let listenPort = 0;
    const guard = new Hono();
    guard.use('*', async (c, next) => {
      // Host (DNS rebinding) + Origin / Sec-Fetch-Site (cross-site request
      // forgery from any page open in the browser) — see local-origin.ts.
      const reason = refuseReason(
        {
          method: c.req.method,
          host: c.req.header('host'),
          origin: c.req.header('origin'),
          secFetchSite: c.req.header('sec-fetch-site'),
        },
        listenPort,
      );
      if (reason) return c.text(`Forbidden (${reason})`, 403);
      await next();
    });
    guard.route('/', app);

    const server: ServerType = serve(
      { fetch: guard.fetch, port: 0, hostname: '127.0.0.1' },
      (info) => {
        listenPort = info.port;
        const url = `http://127.0.0.1:${info.port}/`;
        process.stderr.write(chalk.gray(`[server] listening at ${url}\n`));
        resolve({
          url,
          port: info.port,
          httpServer: server,
          stop: () =>
            new Promise<void>((res) => {
              server.close(() => res());
            }),
        });
      },
    );
  });
}
