import { useState } from 'react';
import { hostHealthText, hostNeedsRestart, type HostHealth } from '../../../../core/pty/host-health.js';
import { restartPtyHost } from '../../api/client.js';

/**
 * Says so when the PTY host — the process every Claude runs in — is slow, has
 * stopped answering, or runs an older work than this one (it outlives updates;
 * core/pty/host-health.ts), instead of terminals that just stop moving — with
 * Restart when that's the cure: the new host resumes every session.
 */
export function HostHealthBanner({ health, restart = restartPtyHost }: { health: HostHealth | null; restart?: typeof restartPtyHost }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const text = health ? hostHealthText(health) : null;
  if (!text && !said) return null;
  const kind = health?.state === 'ok' && health.outdated ? 'outdated' : (health?.state ?? 'ok');
  const doRestart = () => {
    setBusy(true);
    setSaid(null);
    restart()
      .then(
        () => setSaid('Restarting the terminal host: sessions resume in a moment.'),
        (e: Error) => setSaid(`Couldn't restart it: ${e.message}`),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className={`wd-host-health wd-host-health-${kind}`} role="alert">
      {said ?? text}
      {health && hostNeedsRestart(health) && !said && (
        <>
          {' '}
          <button type="button" className="wd-btn-secondary" disabled={busy} onClick={doRestart}>
            {busy ? 'Restarting…' : 'Restart it'}
          </button>
        </>
      )}
    </div>
  );
}
