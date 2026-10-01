import { useState } from 'react';
import { catchUpSession, type SessionSummary } from '../../api/client.js';
import { lastActiveAt } from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';

/** Quiet this long, and the header suggests catching up. */
export const AWAY_MS = 2 * 24 * 3600_000;

/**
 * "Catch me up" in the session header: a few sentences on where the session
 * stands, written from its last week of conversation (catch-up.ts). After two
 * quiet days the button says how long you've been away.
 */
export function CatchUpButton({ session, now = Date.now() }: { session: SessionSummary; now?: number }) {
  const [state, setState] = useState<{ busy: boolean; text?: string; at?: string; error?: string; open: boolean }>({ busy: false, open: false });
  const away = now - Date.parse(lastActiveAt(session));
  const run = () => {
    setState((s) => ({ ...s, busy: true, error: undefined, open: true }));
    catchUpSession(session.id).then(
      (c) => setState({ busy: false, text: c.text, at: c.at, open: true }),
      (err: Error) => setState({ busy: false, error: err.message, open: true }),
    );
  };
  return (
    <>
      <button
        type="button"
        className={'wd-session-detail-btn' + (away >= AWAY_MS ? ' wd-catch-up-away' : '')}
        onClick={run}
        disabled={state.busy}
        title="A few sentences on where it stands, what's left, and whether anything waits on you (from its last week of conversation)"
      >
        {state.busy ? 'Catching up…' : away >= AWAY_MS ? `Away ${relativeTime(lastActiveAt(session), now)} — catch me up` : 'Catch me up'}
      </button>
      {state.open && (
        <div className="wd-catch-up" role="status" aria-live="polite">
          {state.busy && !state.text ? (
            <p className="wd-catch-up-text wd-tab-header-muted">Reading its conversation…</p>
          ) : state.error ? (
            <p className="wd-catch-up-text wd-tab-error">{state.error}</p>
          ) : (
            <p className="wd-catch-up-text">{state.text}</p>
          )}
          <span className="wd-catch-up-meta">
            {state.at && `written ${relativeTime(state.at, now)}${relativeTime(state.at, now) === 'just now' ? '' : ' ago'} · `}
            <button type="button" className="wd-link-button" onClick={run} disabled={state.busy}>
              Refresh
            </button>
            {' · '}
            <button type="button" className="wd-link-button" onClick={() => setState((s) => ({ ...s, open: false }))}>
              Close
            </button>
          </span>
        </div>
      )}
    </>
  );
}
