import { useEffect, useState } from 'react';
import { fetchContext, type AppContext } from './api/client.js';
import { DashboardApp } from './apps/DashboardApp.js';
import { ReviewApp } from './apps/ReviewApp.js';

/**
 * Top-level router. Three modes:
 *
 *   /diff/<hash>     — read-only diff view of a scope registered by `wd`.
 *                       Same SPA, same ReviewApp, just routed through
 *                       `/api/scopes/<hash>/...` instead of `/api/diff`.
 *   /review/<hash>   — same but with the comment composer enabled
 *                       (mounts ReviewProvider against the scope's
 *                       comment endpoints).
 *   /                — falls back to `/api/context`. Dashboard or
 *                       standalone review depending on which server
 *                       is responding.
 *
 * Path-based routing is browser-bookmarkable; the server-side SPA
 * fallback in `spa-handler.ts` serves index.html for any non-/api path,
 * so deep links work directly.
 */
export function App() {
  const [context, setContext] = useState<AppContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Parse the URL path once. /diff/abc123 and /review/abc123 take
  // precedence over the server-reported mode — same SPA serves both.
  const urlScope = parseScopeFromPath(window.location.pathname);

  useEffect(() => {
    // Scope URLs short-circuit the context fetch — we synthesize a
    // ReviewContext below. Avoids an extra round-trip and means
    // /diff/<hash> still works if /api/context is misbehaving.
    if (urlScope) {
      setContext({
        mode: 'review',
        scopeLabel: urlScope.hash,
        repos: [],
        readOnly: urlScope.kind === 'diff',
      });
      return;
    }
    let cancelled = false;
    fetchContext().then(
      (ctx) => { if (!cancelled) setContext(ctx); },
      (err: Error) => { if (!cancelled) setError(err.message); },
    );
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return <div className="wd-web-error">{error}</div>;
  }
  if (!context) {
    return <div className="wd-web-empty">Connecting…</div>;
  }
  if (urlScope) {
    return <ReviewApp context={context as never} scopeHash={urlScope.hash} />;
  }
  if (context.mode === 'review') {
    return <ReviewApp context={context} />;
  }
  return <DashboardApp />;
}

/** Detect `/diff/<hash>` or `/review/<hash>`. Returns `null` for any
 *  other path. */
function parseScopeFromPath(
  pathname: string,
): { kind: 'diff' | 'review'; hash: string } | null {
  const m = pathname.match(/^\/(diff|review)\/([a-zA-Z0-9_-]+)\/?$/);
  if (!m) return null;
  return { kind: m[1] as 'diff' | 'review', hash: m[2] };
}
