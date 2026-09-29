import { useMemo, useState } from 'react';
import { useNotificationPermission } from '../../../hooks/use-presence.js';
import { markSessionSeen, type SessionSummary } from '../../../api/client.js';
import { isArchived, type PrLookup } from '../../../state/session-display.js';
import { DiffStatChip, PrChips } from '../SessionBits.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import { attentionRank, compareAttention } from '../../../../../core/attention.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  /** Open a session on the sub-tab that fits why it's here: the terminal to
   *  answer a question, the diff to review finished work. */
  onOpenSession: (id: string, sub: SessionSubTab) => void;
  /** Open PRs for a session; rows skip the badge without it. */
  prsFor?: PrLookup;
  /** Clear a finished session's unseen flag without opening it. Defaults
   *  to the API call; injectable for tests. */
  onMarkSeen?: (id: string) => Promise<unknown>;
}

interface Section {
  rank: number;
  title: string;
  hint: string;
  /** Verb for the "since" column. */
  since: string;
  open: SessionSubTab;
}

const SECTIONS: Section[] = [
  { rank: 0, title: 'Needs your input', hint: 'Blocked on a permission or question', since: 'waiting', open: 'term' },
  { rank: 1, title: 'Done — not looked at yet', hint: 'Finished a turn since you last opened it', since: 'done', open: 'diff' },
  { rank: 2, title: 'Working', hint: 'Mid-turn', since: 'working', open: 'term' },
];

/**
 * The attention inbox: every session whose Claude wants you, in the order
 * you should get to them — blocked first (longest-waiting on top), then
 * finished-but-unseen, then what's still running. Quiet sessions are only
 * counted. Driven by Claude's own hooks (see core/session-status.ts).
 */
/** Browser notifications need a click to ask for permission. Once granted,
 *  sessions that want you notify here (click to jump) — only when you're
 *  not already looking at them — instead of as a desktop toast. */
function NotificationToggle() {
  const { state, request } = useNotificationPermission();
  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return (
      <span className="wd-tab-header-muted wd-notify-state" title="Sessions notify here only when you're not looking at them">
        🔔 Notifications on
      </span>
    );
  }
  if (state === 'denied') {
    return (
      <span className="wd-tab-header-muted wd-notify-state" title="Allow notifications for this site in the browser to turn them on">
        🔕 Notifications blocked
      </span>
    );
  }
  return (
    <button type="button" className="wd-btn-secondary wd-notify-enable" onClick={request}>
      Enable notifications
    </button>
  );
}

export function InboxTab({
  sessions,
  onOpenSession,
  prsFor,
  onMarkSeen = markSessionSeen,
}: Props) {
  const [marking, setMarking] = useState<Set<string>>(new Set());
  const markSeen = (id: string) => {
    setMarking((m) => new Set(m).add(id));
    onMarkSeen(id).finally(() =>
      setMarking((m) => {
        const next = new Set(m);
        next.delete(id);
        return next;
      }),
    );
  };
  const { bySection, quiet, tracked } = useMemo(() => {
    const sorted = sessions.filter((s) => !isArchived(s)).sort((a, b) => compareAttention(a.attention, b.attention));
    const bySection = new Map<number, SessionSummary[]>();
    let quiet = 0;
    let tracked = 0;
    for (const s of sorted) {
      if (s.attention) tracked++;
      const rank = attentionRank(s.attention);
      if (rank > 2) {
        if (s.attention) quiet++;
        continue;
      }
      bySection.set(rank, [...(bySection.get(rank) ?? []), s]);
    }
    return { bySection, quiet, tracked };
  }, [sessions]);

  const waitingCount = (bySection.get(0)?.length ?? 0) + (bySection.get(1)?.length ?? 0);

  return (
    <div className="wd-dash-tab-pane wd-tab-inbox">
      <header className="wd-tab-header">
        <h1>
          Inbox{' '}
          <span className="wd-tab-header-muted">
            ({waitingCount} need{waitingCount === 1 ? 's' : ''} you · {bySection.get(2)?.length ?? 0} working
            {quiet > 0 ? ` · ${quiet} quiet` : ''})
          </span>
        </h1>
        <span className="wd-tab-header-muted">
          Press <kbd>n</kbd> to jump to the next one
        </span>
        <NotificationToggle />
      </header>
      {tracked === 0 ? (
        <div className="wd-tab-empty">
          No session has reported its status yet. Status comes from Claude&apos;s
          hooks, which the full <code>work web</code> installs (not the lean one{' '}
          <code>wd</code> starts) — they apply to Claudes started, or prompted,
          after that.
        </div>
      ) : waitingCount === 0 && !bySection.get(2)?.length ? (
        <div className="wd-tab-empty">Nothing needs you right now.</div>
      ) : (
        SECTIONS.filter((sec) => bySection.get(sec.rank)?.length).map((sec) => (
          <section key={sec.rank} className={`wd-inbox-section wd-inbox-rank-${sec.rank}`}>
            <h2 className="wd-inbox-section-title" title={sec.hint}>
              {sec.title}{' '}
              <span className="wd-tab-header-muted">({bySection.get(sec.rank)!.length})</span>
            </h2>
            <ul className="wd-inbox-list">
              {bySection.get(sec.rank)!.map((s) => (
                <li key={s.id} className="wd-inbox-item">
                  <button
                    type="button"
                    className="wd-inbox-row"
                    onClick={() => onOpenSession(s.id, sec.open)}
                    title={`Open ${s.target} · ${s.branch} (${sec.open === 'term' ? 'terminal' : 'diff'})`}
                  >
                    <span className={`wd-inbox-dot wd-inbox-dot-${s.attention!.state}`} aria-hidden />
                    <span className="wd-inbox-name">
                      <span className="wd-inbox-target">{s.target}</span>
                      <span className="wd-inbox-branch">{s.branch}</span>
                    </span>
                    <span className="wd-inbox-summary">
                      {s.attention!.summary ?? <span className="wd-tab-header-muted">—</span>}
                    </span>
                    <span className="wd-inbox-meta">
                      <DiffStatChip session={s} />
                      <PrChips prs={prsFor?.(s) ?? []} />
                      <span className="wd-inbox-since">
                        {sec.since} {relativeTime(s.attention!.since)}
                      </span>
                    </span>
                  </button>
                  <span className="wd-inbox-actions">
                    <button type="button" className="wd-row-action" onClick={() => onOpenSession(s.id, 'diff')}>
                      Diff
                    </button>
                    <button type="button" className="wd-row-action" onClick={() => onOpenSession(s.id, 'term')}>
                      Terminal
                    </button>
                    {sec.rank === 1 && (
                      <button
                        type="button"
                        className="wd-row-action"
                        disabled={marking.has(s.id)}
                        onClick={() => markSeen(s.id)}
                        title="Clear it from the inbox without opening it"
                      >
                        {marking.has(s.id) ? 'Marking…' : 'Mark seen'}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
