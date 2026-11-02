import type { Hono } from 'hono';
import type { HostHealth } from '../../core/pty/host-health.js';
import type { StopOutcome } from '../../core/pty/host-control.js';
import type { PtyHostRestartWire } from '../../core/api-types.js';
import { report } from '../../core/platform/report.js';

/**
 * The PTY host as the dashboard sees it: how it's doing (host-health.ts) and Restart (the banner's button, for a host
 * that's stuck or older than this work). Restart is `restartHost` with force: a hung host is stopped too, once it
 * proves to be work's (host-control.ts), and the new one restores every session with --continue.
 */
export interface PtyHostRouteDeps {
  /** The dev server never restarts the host: the installed work owns it. */
  dev: boolean;
  health: () => HostHealth;
  restart: () => Promise<{ outcome: StopOutcome; pid: number | null }>;
  broadcast: (event: string, data: unknown) => void;
}

const SAID: Record<StopOutcome | 'failed', string> = {
  stopped: 'restarted it; sessions are being restored',
  'not-running': 'started one; sessions are being restored',
  'stale-file': 'started one; sessions are being restored',
  unresponsive: "it doesn't answer, and its process doesn't look like work's PTY host: nothing was stopped",
  failed: "couldn't stop it",
};

export function mountPtyHostRoutes(app: Hono, deps: PtyHostRouteDeps): void {
  app.get('/api/pty-host/health', (c) => c.json(deps.health()));

  app.post('/api/pty-host/restart', async (c) => {
    if (deps.dev) return c.json({ error: "the dev server doesn't restart the PTY host: the installed work owns it" }, 409);
    const r = await deps.restart().catch((err: Error) => ({ outcome: 'failed' as const, pid: null, error: err.message }));
    const said = SAID[r.outcome];
    const why = 'error' in r && r.error ? ` (${r.error})` : '';
    report(r.pid ? 'info' : 'warn', `[web] PTY host restart: ${said}${why}`);
    if (!r.pid || r.outcome === 'failed' || r.outcome === 'unresponsive') return c.json({ error: said + why }, 409);
    deps.broadcast('host-health', deps.health());
    return c.json({ outcome: r.outcome, pid: r.pid } satisfies PtyHostRestartWire);
  });
}
