import { useState } from 'react';
import type { UpdateWire } from '../../../../core/api-types.js';

const LATER_KEY = 'work:update-later';

function laterFor(): string | null {
  try {
    return localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}

/**
 * A newer work, in a small card at the bottom right — only when there's one:
 * the desktop app downloaded it (Restart), is getting it, or (npm / a git
 * checkout) the command that updates it. Later hides it until a newer one
 * (per browser).
 */
export function UpdateStrip({
  updates,
  onRestart,
  onWhatsNew,
  restarting: restartAsked = false,
}: {
  updates: UpdateWire | null;
  onRestart: () => Promise<unknown>;
  onWhatsNew: () => void;
  /** Restart was asked elsewhere too (Help's Restart to update): say it's installing. */
  restarting?: boolean;
}) {
  const [later, setLater] = useState<string | null>(laterFor);
  const [clicked, setRestarting] = useState(false);
  const restarting = clicked || restartAsked;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const a = updates?.available;
  if (!a || (later === a.version && !restarting)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(LATER_KEY, a.version);
    } catch {
      /* this time only */
    }
    setLater(a.version);
  };
  return (
    <div className="wd-update-strip" role="status" aria-label="Update">
      <span className="wd-update-text">
        {restarting
          ? `Installing work ${a.version}: the app closes and comes back on it in a moment. Your Claudes keep running.`
          : a.how === 'restart'
            ? `work ${a.version} is ready.`
            : a.how === 'downloading'
              ? `work ${a.version} is on its way: the app is downloading it.`
              : `work ${a.version} is out.`}
      </span>
      {a.how === 'command' && a.command && (
        <span className="wd-update-command">
          <code>{a.command}</code>
          <button
            type="button"
            className="wd-link-button"
            onClick={() =>
              void navigator.clipboard.writeText(a.command!).then(
                () => setCopied(true),
                () => setError("Couldn't copy to the clipboard"),
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      )}
      <span className="wd-update-actions">
        <button type="button" className="wd-link-button" onClick={onWhatsNew}>
          What&apos;s new
        </button>
        {a.how === 'restart' && (
          <button
            type="button"
            className="wd-btn-primary"
            disabled={restarting}
            title="The app closes and comes back on it; your Claudes keep running"
            onClick={() => {
              setRestarting(true);
              setError(null);
              onRestart().catch((err: Error) => {
                setRestarting(false);
                setError(err.message);
              });
            }}
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
        )}
        <button type="button" className="wd-link-button" onClick={dismiss}>
          Later
        </button>
      </span>
      {error && (
        <span className="wd-repos-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
