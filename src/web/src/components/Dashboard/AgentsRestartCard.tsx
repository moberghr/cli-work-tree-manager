import { useState } from 'react';
import type { AgentsWire } from '../../../../core/api-types.js';
import { outdatedText, queuedText, restartLabel } from '../../state/agent-restart-view.js';

const LATER_KEY = 'work:agents-restart-later';

function laterFor(): string | null {
  try {
    return localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}

/**
 * Sessions whose agent still runs a version from before its tool updated (Claude Code replaced itself; a
 * running Claude keeps the old one until it starts again), in the update card's place at the bottom right:
 * Restart them — each picks up its conversation, one at work after its turn. Later hides it until the tool
 * updates again (per browser).
 */
export function AgentsRestartCard({
  agents,
  onRestart,
  restarting,
  note,
}: {
  agents: AgentsWire | null;
  onRestart: () => void;
  restarting: boolean;
  note: string | null;
}) {
  const [later, setLater] = useState<string | null>(laterFor);
  const text = outdatedText(agents);
  if (!agents || !text) return note ? <Shown text={note} /> : null;
  const key = agents.installedAt ?? 'unknown';
  if (later === key && !restarting) return null;
  const label = restartLabel(agents);
  const waiting = queuedText(agents);
  const dismiss = () => {
    try {
      localStorage.setItem(LATER_KEY, key);
    } catch {
      /* this time only */
    }
    setLater(key);
  };
  return (
    <div className="wd-update-strip" role="status" aria-label="Restart agents">
      <span className="wd-update-text">{text}</span>
      <span className="wd-update-actions">
        <button type="button" className="wd-link-button" onClick={dismiss}>
          Later
        </button>
        {label && (
          <button type="button" className="wd-btn-primary" disabled={restarting} onClick={onRestart}>
            {restarting ? 'Restarting…' : label}
          </button>
        )}
      </span>
      <span className="wd-update-sub">
        {note ?? waiting ?? 'Each picks up its conversation where it was; one at work restarts when its turn ends.'}
      </span>
    </div>
  );
}

/** How the restart went, once nothing is outdated any more. */
function Shown({ text }: { text: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return (
    <div className="wd-update-strip" role="status" aria-label="Restart agents">
      <span className="wd-update-text">{text}</span>
      <span className="wd-update-actions">
        <button type="button" className="wd-link-button" onClick={() => setGone(true)}>
          OK
        </button>
      </span>
    </div>
  );
}
