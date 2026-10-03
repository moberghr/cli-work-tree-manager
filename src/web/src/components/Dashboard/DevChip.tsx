import { useCallback, useEffect, useState } from 'react';
import { devAction, fetchDevState, type DevServerState } from '../../api/client.js';
import { useSse } from '../../api/events.js';

/** How often to re-probe the port while a session is open — catches a dev
 *  server Claude (or you, in the terminal) started on $PORT. */
const POLL_MS = 5_000;

/** The worktree's dev server as the session header knows it, and Start / Stop. */
export interface DevHandle {
  sessionId: string;
  state: DevServerState | null;
  busy: 'start' | 'stop' | null;
  error: string | null;
  act: (a: 'start' | 'stop') => void;
}

/**
 * Whether something serves on the worktree's port, and Start / Stop for the
 * configured dev command (`devCommands` in config.json). The header's ⋯ menu
 * starts and stops it; the chip shows it while it runs.
 */
export function useDevState(sessionId: string): DevHandle {
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

  const act = useCallback(
    (a: 'start' | 'stop') => {
      setBusy(a);
      setError(null);
      devAction(sessionId, a)
        .catch((err: Error) => setError(err.message))
        .finally(() => {
          setBusy(null);
          load();
        });
    },
    [sessionId, load],
  );
  return { sessionId, state, busy, error, act };
}

/**
 * The dev server in the session's status line, while there is one: its
 * port, a Preview link once it answers, Stop and its log. Nothing when no
 * server runs (Start is in the ⋯ menu), except a failed start or stop.
 */
export function DevChip({ dev }: { dev: DevHandle }) {
  const { sessionId, state, busy, error, act } = dev;
  if (!state || state.port === null) return null;
  const live = !!state.running || state.listening || busy === 'start';
  if (!live && !error) return null;
  const starting = (!!state.running || busy === 'start') && !state.listening;
  const logHref = `/api/sessions/${encodeURIComponent(sessionId)}/dev/log`;
  return (
    <span className={'wd-dev-chip' + (state.listening ? ' wd-dev-live' : '')}>
      {live && (
        <span
          className="wd-dev-port"
          title={
            state.listening ? `Something is serving on port ${state.port} ($PORT)` : `Nothing is listening on port ${state.port} ($PORT)`
          }
        >
          <span className="wd-dev-dot" aria-hidden="true">
            {state.listening ? '●' : '○'}
          </span>{' '}
          :{state.port}
        </span>
      )}
      {state.listening && state.url && (
        <a className="wd-dev-preview" href={state.url} target="_blank" rel="noopener noreferrer">
          Preview ↗
        </a>
      )}
      {starting && <span className="wd-tab-header-muted">starting…</span>}
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
