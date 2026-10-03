import { useEffect, useState } from 'react';
import { fetchTimeline, type SessionSummary } from '../../api/client.js';
import type { TimelineEvent, TimelineKind } from '../../../../core/conversations/timeline.js';

const ICON: Record<TimelineKind, string> = {
  created: '✦',
  prompt: '›',
  turn: '✓',
  commit: '●',
  'pr-opened': '⇡',
  'pr-merged': '⇣',
  'pr-closed': '✕',
  archived: '▣',
};

const KIND_LABEL: Record<TimelineKind, string> = {
  created: 'Started',
  prompt: 'You',
  turn: 'Turn',
  commit: 'Commit',
  'pr-opened': 'PR',
  'pr-merged': 'Merged',
  'pr-closed': 'Closed',
  archived: 'Archived',
};

/** Events by local day, newest day first (they arrive newest first). Pure. */
export function byDay(events: TimelineEvent[]): Array<{ day: string; events: TimelineEvent[] }> {
  const out: Array<{ day: string; events: TimelineEvent[] }> = [];
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const last = out[out.length - 1];
    if (last?.day === day) last.events.push(e);
    else out.push({ day, events: [e] });
  }
  return out;
}

/**
 * The Timeline tab (core/timeline.ts): how the session got where it is — your
 * prompts, its turns, commits and PRs, newest first, by day. A turn opens its
 * diff; a PR its page.
 */
export function TimelineView({ session, onOpenTurn }: { session: SessionSummary; onOpenTurn?: (checkpoint: number) => void }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    fetchTimeline(session.id).then(
      (e) => live && setEvents(e),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
    // Again when its conversation moves (a new prompt, a finished turn).
  }, [session.id, session.lastActivity]);
  if (error) return <div className="wd-tab-empty wd-tab-error">{error}</div>;
  if (!events) return <div className="wd-tab-empty" role="status"><span className="wd-spinner" aria-hidden /> Reading its history…</div>;
  return (
    <div className="wd-timeline">
      {byDay(events).map((g) => (
        <section key={g.day} className="wd-timeline-day">
          <h3 className="wd-timeline-day-title">{g.day}</h3>
          <ol className="wd-timeline-list">
            {g.events.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${i}`} className={`wd-timeline-event wd-timeline-${e.kind}`}>
                <span className="wd-timeline-time">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="wd-timeline-icon" aria-hidden>{ICON[e.kind]}</span>
                <span className="wd-timeline-kind">{KIND_LABEL[e.kind]}</span>
                <span className="wd-timeline-text">
                  {e.kind === 'turn' && e.checkpoint && onOpenTurn ? (
                    <button type="button" className="wd-link-button" onClick={() => onOpenTurn(e.checkpoint!)} title="Open what this turn changed">
                      {e.text}
                    </button>
                  ) : e.ref?.startsWith('https://') ? (
                    <a href={e.ref} target="_blank" rel="noreferrer">
                      {e.text}
                    </a>
                  ) : (
                    e.text
                  )}
                  {e.repo && session.isGroup && <span className="wd-timeline-repo"> · {e.repo}</span>}
                  {e.kind === 'commit' && e.ref && <code className="wd-timeline-sha">{e.ref.slice(0, 7)}</code>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
