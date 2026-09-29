import { useCallback, useEffect, useState } from 'react';
import { devAction, fetchDevState, type DevServerState } from '../../api/client.js';
import { useSse } from '../../api/events.js';

/** How often to re-probe the port while a session is open — catches a dev
 *  server Claude (or you, in the terminal) started on $PORT. */
const POLL_MS = 5_000;

/**
 * The worktree's port in the session header: whether something serves on
 * it, a Preview link when it does, and Start / Stop for the configured
 * dev command (`devCommands` in config.json).
 */
export function DevChip({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<DevServerState | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchDevState(sessionId).then(
      (s) => setState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(s) ? prev : s)),
      () => {},
    );
  }, [sessionId]);
  useEffect(() => {
    setState(null);
    setError(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useSse('/events', {
    events: {
      'dev-changed': (d) => {
        if ((d as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });

  if (!state || state.port === null) return null;
  const act = async (a: 'start' | 'stop') => {
    setBusy(a);
    setError(null);
    try {
      await devAction(sessionId, a);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  };
  const starting = !!state.running && !state.listening;
  const logHref = `/api/sessions/${encodeURIComponent(sessionId)}/dev/log`;
  return (
    <span className={'wd-dev-chip' + (state.listening ? ' wd-dev-live' : '')}>
      <span
        className="wd-dev-port"
        title={state.listening ? `Something is serving on port ${state.port} ($PORT)` : `Nothing is listening on port ${state.port} ($PORT)`}
      >
        <span className="wd-dev-dot" aria-hidden="true">{state.listening ? '●' : '○'}</span> :{state.port}
      </span>
      {state.listening && state.url && (
        <a className="wd-dev-preview" href={state.url} target="_blank" rel="noopener noreferrer">
          Preview ↗
        </a>
      )}
      {starting && <span className="wd-tab-header-muted">starting…</span>}
      {state.command && !state.running && !state.listening && (
        <button type="button" className="wd-dev-btn" disabled={busy !== null} onClick={() => act('start')} title={`Run \`${state.command}\` in ${state.repo} with PORT=${state.port}`}>
          {busy === 'start' ? 'Starting…' : '▶ Start dev'}
        </button>
      )}
      {state.running && (
        <>
          <button type="button" className="wd-dev-btn" disabled={busy !== null} onClick={() => act('stop')} title="Stop the dev server">
            {busy === 'stop' ? 'Stopping…' : '■ Stop'}
          </button>
          <a className="wd-dev-log" href={logHref} target="_blank" rel="noopener noreferrer">
            Log
          </a>
        </>
      )}
      {error && (
        <span className="wd-dev-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
