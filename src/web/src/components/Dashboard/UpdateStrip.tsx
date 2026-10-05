import { useEffect, useState } from 'react';
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
  // Installing: asked here, from Help, or by the app itself (a browser tab hears it through the server).
  const restarting = clicked || restartAsked || updates?.desktop?.state === 'installing';
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const a = updates?.available;
  // A Restart that didn't happen (applying failed): nothing to install now, so the card's own click is over.
  useEffect(() => {
    if (a?.how !== 'restart') setRestarting(false);
  }, [a?.how, a?.version]);
  // What Later hides: this version — or only its download, so the Restart card still comes when it's ready.
  const laterKey = a ? (a.how === 'downloading' ? `${a.version}:downloading` : a.version) : '';
  if (!a || (later === laterKey && !restarting)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(LATER_KEY, laterKey);
    } catch {
      /* this time only */
    }
    setLater(laterKey);
  };
  const restartButton = (
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
  );
  const whatsNew = (
    <button type="button" className="wd-link-button" onClick={onWhatsNew}>
      What&apos;s new
    </button>
  );
  const laterButton = (
    <button type="button" className="wd-link-button" onClick={dismiss}>
      Later
    </button>
  );
  const pct = a.how === 'downloading' && typeof a.progress === 'number' ? a.progress : null;
  return (
    <div className="wd-update-strip" role="status" aria-label="Update">
      {restarting ? (
        <>
          <span className="wd-update-text">Installing work {a.version}…</span>
          <ProgressBar />
          <span className="wd-update-sub">The app closes and comes back in a few seconds. Your Claudes keep running.</span>
        </>
      ) : a.how === 'downloading' && pct !== null ? (
        <>
          <span className="wd-update-text">
            Downloading work {a.version} · {pct}%
          </span>
          <span className="wd-update-actions">
            {whatsNew}
            {laterButton}
          </span>
          <ProgressBar value={pct} />
          <span className="wd-update-sub">You can keep working; it installs when you restart.</span>
        </>
      ) : a.how === 'downloading' ? (
        // No percentage (a browser tab, or an app that stopped saying): nothing to draw a bar from.
        <>
          <span className="wd-update-text">work {a.version} is out. The app gets it by itself and says when it&apos;s ready.</span>
          <span className="wd-update-actions">
            {whatsNew}
            {laterButton}
          </span>
        </>
      ) : a.how === 'restart' ? (
        <>
          <span className="wd-update-text">work {a.version} is ready.</span>
          <span className="wd-update-actions">
            {whatsNew}
            {laterButton}
            {restartButton}
          </span>
          <span className="wd-update-sub">The app closes and comes back on {a.version} in a few seconds. Your Claudes keep running.</span>
        </>
      ) : (
        <>
          <span className="wd-update-text">work {a.version} is out.</span>
          {a.command && (
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
            {whatsNew}
            {laterButton}
          </span>
        </>
      )}
      {error && (
        <span className="wd-repos-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * How far a download is (0-100), or a bar that moves without a number while
 * the amount isn't known (the install after Restart). Shared with HelpMenu.
 */
export function ProgressBar({ value = null }: { value?: number | null }) {
  return value === null ? (
    <span className="wd-update-bar wd-update-bar-moving" role="progressbar" aria-label="In progress">
      <i />
    </span>
  ) : (
    <span className="wd-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}
