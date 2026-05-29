import { useEffect, useState } from 'react';
import { fetchContext, type AppContext } from './api/client.js';
import { DashboardApp } from './apps/DashboardApp.js';
import { ReviewApp } from './apps/ReviewApp.js';

/**
 * Top-level router. The SPA boots, asks the server which mode it's in via
 * /api/context, then mounts either the dashboard (multi-session sidebar)
 * or the review (single-scope, no sidebar).
 */
export function App() {
  const [context, setContext] = useState<AppContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchContext().then(
      (ctx) => {
        if (!cancelled) setContext(ctx);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="wd-web-error">{error}</div>;
  }
  if (!context) {
    return <div className="wd-web-empty">Connecting…</div>;
  }
  if (context.mode === 'review') {
    return <ReviewApp context={context} />;
  }
  return <DashboardApp />;
}
