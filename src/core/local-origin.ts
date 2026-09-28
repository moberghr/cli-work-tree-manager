/**
 * Who may talk to our localhost servers (work web / wd / comment server).
 *
 * Binding to 127.0.0.1 keeps the network out, and the Host check stops DNS
 * rebinding — but neither stops a web page you have open from making YOUR
 * browser send requests to 127.0.0.1:<port> (cross-site request forgery).
 * The port is predictable and session ids are guessable, and the terminal
 * WebSocket types straight into Claude — so every request that changes
 * something, and every WebSocket upgrade, must come from our own origin.
 *
 * Rules:
 *   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding).
 *   - A browser marking the request `Sec-Fetch-Site: cross-site` is refused.
 *   - Mutating requests (anything but GET/HEAD/OPTIONS) and WebSocket
 *     upgrades: `Origin` must be absent (non-browser callers — the Claude
 *     hooks, `wd`, the CLI — send none) or exactly our own origin. Browsers
 *     always send Origin on cross-origin POSTs and on every WebSocket, and a
 *     page can't forge it. `Origin: null` (sandboxed frames, file://) is
 *     refused.
 */

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === '') return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestFacts {
  method: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
  /** A WebSocket upgrade — always checked like a mutating request. */
  upgrade?: boolean;
}

/** Null when allowed, else a short reason (for the 403 body / logs). */
export function refuseReason(req: RequestFacts, port: number): string | null {
  if (!allowedHost(req.host, port)) return 'bad host';
  if (req.secFetchSite === 'cross-site') return 'cross-site request';
  const mutating = req.upgrade || !SAFE_METHODS.has(req.method.toUpperCase());
  if (mutating && !allowedOrigin(req.origin, port)) return 'foreign origin';
  return null;
}
