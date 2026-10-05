import { useCallback, useState } from 'react';
import { catchUpSession, type SessionSummary } from '../../api/client.js';
import { lastActiveAt } from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';

/** Quiet this long, and the status line suggests catching up. */
export const AWAY_MS = 2 * 24 * 3600_000;

export interface CatchUpState {
  busy: boolean;
  open: boolean;
  text?: string;
  at?: string;
  error?: string;
}

export interface CatchUp {
  state: CatchUpState;
  run: () => void;
  close: () => void;
}

/**
 * "Catch me up" (the ⋯ menu, or "Away 3d" in the status line): a few
 * sentences on where the session stands, written from its last week of
 * conversation (catch-up.ts).
 */
export function useCatchUp(sessionId: string): CatchUp {
  const [state, setState] = useState<CatchUpState>({ busy: false, open: false });
  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined, open: true }));
    catchUpSession(sessionId).then(
      (c) => setState({ busy: false, text: c.text, at: c.at, open: true }),
      (err: Error) => setState({ busy: false, error: err.message, open: true }),
    );
  }, [sessionId]);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { state, run, close };
}

/** How long it has been quiet, when that's two days or more. */
export function awayFor(session: SessionSummary, now: number): string | null {
  return now - Date.parse(lastActiveAt(session)) >= AWAY_MS ? relativeTime(lastActiveAt(session), now) : null;
}

/** In the status line after two quiet days: "Away 3d · Catch me up". */
export function AwayLink({ session, catchUp, now = Date.now() }: { session: SessionSummary; catchUp: CatchUp; now?: number }) {
  const away = awayFor(session, now);
  if (!away || catchUp.state.open) return null;
  return (
    <button
      type="button"
      className="wd-link-button wd-catch-up-away"
      onClick={catchUp.run}
      disabled={catchUp.state.busy}
      title="A few sentences on where it stands, what's left, and whether anything waits on you (from its last week of conversation)"
    >
      Away {away} · Catch me up
    </button>
  );
}

/** The summary, under the status line, while it's open. */
export function CatchUpPanel({ catchUp, now = Date.now() }: { catchUp: CatchUp; now?: number }) {
  const { state, run, close } = catchUp;
  if (!state.open) return null;
  return (
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
        <button type="button" className="wd-link-button" onClick={close}>
          Close
        </button>
      </span>
    </div>
  );
}
