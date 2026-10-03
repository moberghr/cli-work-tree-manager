import { useMemo, useState } from 'react';
import { SnoozeUntilDialog } from '../SnoozeUntilDialog.js';
import { RowMenu } from '../RowMenu.js';
import { useNotificationPermission } from '../../../hooks/use-presence.js';
import {
  answerPermission,
  markSessionSeen,
  type AnswerRequest,
  type SessionSummary,
  snoozeSession,
  unsnoozeSession,
} from '../../../api/client.js';
import { snoozeLabel } from '../../../../../core/rail/snooze.js';
import { isArchived, lastActiveAt, agentCan, agentName } from '../../../state/session-display.js';
import { StatusIcon } from '../StatusIcon.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import { compareInbox, inboxRank } from '../../../../../core/status/attention.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  /** Open a session on the sub-tab that fits why it's here: the terminal to
   *  answer a question, the diff to review finished work. */
  onOpenSession: (id: string, sub: SessionSubTab, opts?: { lastTurn?: boolean }) => void;
  /** Start the review queue over the Done section. */
  onReviewAll?: () => void;
  /** Clear a finished session's unseen flag without opening it. Defaults
   *  to the API call; injectable for tests. */
  onMarkSeen?: (id: string) => Promise<unknown>;
  /** Allow / Deny a permission prompt. Defaults to the API call. */
  onAnswer?: (id: string, req: AnswerRequest) => Promise<unknown>;
}

interface Section {
  rank: number;
  title: string;
  hint: string;
  kind: 'needs_input' | 'done' | 'review';
  /** Where a row opens, and its one action's name. */
  open: SessionSubTab;
  action: string;
}

/** Only what wants you: a question, finished work, review comments. Everything else is in the rail. */
const SECTIONS: Section[] = [
  { rank: 0, title: 'Needs your input', hint: 'Blocked on a permission or question', kind: 'needs_input', open: 'term', action: 'Open' },
  { rank: 1, title: 'Done', hint: 'Finished a turn since you last opened it', kind: 'done', open: 'diff', action: 'Review' },
  {
    rank: 2,
    title: 'Review comments',
    hint: 'Reviewers left comments on its PR that nobody has answered or resolved',
    kind: 'review',
    open: 'diff',
    action: 'Open',
  },
];

type RestCounts = { working: number; quiet: number; snoozed: number; waiting: number };

/** The closing line's parts, each with what it counts ("2 snoozed" can be opened). Pure. */
export function inboxRestParts(c: RestCounts): Array<{ key: keyof RestCounts; text: string }> {
  return [
    { key: 'working' as const, text: `${c.working} working` },
    { key: 'quiet' as const, text: `${c.quiet} quiet` },
    { key: 'snoozed' as const, text: `${c.snoozed} snoozed` },
    { key: 'waiting' as const, text: `${c.waiting} waiting on others` },
  ].filter((p) => c[p.key] > 0);
}

/** "they're in the list on the left." (or "it's", for one). */
const restTail = (c: RestCounts) => `${c.working + c.quiet + c.snoozed + c.waiting === 1 ? "it's" : "they're"} in the list on the left.`;

/** What the Inbox leaves to the rail, in a line: "1 working, 3 quiet — they're in the list on the left." Pure. */
export function inboxRestLine(c: RestCounts): string | null {
  const parts = inboxRestParts(c);
  return parts.length ? `${parts.map((p) => p.text).join(', ')} — ${restTail(c)}` : null;
}

/** Browser notifications need a click to ask for permission: offered once, quietly, until granted or refused. */
function NotificationOffer() {
  const { state, request } = useNotificationPermission();
  if (state !== 'default') return null;
  return (
    <button
      type="button"
      className="wd-link-button wd-notify-enable"
      onClick={request}
      title="Sessions that want you notify here (click to jump), only when you're not looking at them"
    >
      Enable notifications
    </button>
  );
}

/**
 * The attention inbox: only the sessions that want you, in the order to get
 * to them — blocked first (longest-waiting on top), then finished and not
 * looked at, then review comments. One action a row (Allow / Deny, Review,
 * Open); Snooze, Mark seen and Terminal show on hover. Everything else is
 * one line at the end, pointing to the rail. Driven by Claude's own hooks
 * (see core/status/session-status.ts).
 */
export function InboxTab({ sessions, onOpenSession, onMarkSeen = markSessionSeen, onAnswer = answerPermission, onReviewAll }: Props) {
  // Per session: the answer being sent, or why the server refused it.
  const [answering, setAnswering] = useState<Record<string, 'allow' | 'deny'>>({});
  const [answerError, setAnswerError] = useState<Record<string, string>>({});
  const answer = (s: SessionSummary, choice: 'allow' | 'deny') => {
    const request = s.attention?.request;
    if (!request) return;
    setAnswering((a) => ({ ...a, [s.id]: choice }));
    setAnswerError(({ [s.id]: _, ...rest }) => rest);
    onAnswer(s.id, { answer: choice, request })
      .catch((err: unknown) => setAnswerError((e) => ({ ...e, [s.id]: err instanceof Error ? err.message : String(err) })))
      .finally(() => setAnswering(({ [s.id]: _, ...rest }) => rest));
  };
  const [marking, setMarking] = useState<Set<string>>(new Set());
  const markSeen = (id: string) => {
    setMarking((m) => new Set(m).add(id));
    // A failed mark leaves the row as it was; the next refresh shows the truth.
    onMarkSeen(id)
      .catch(() => {})
      .finally(() =>
        setMarking((m) => {
          const next = new Set(m);
          next.delete(id);
          return next;
        }),
      );
  };
  const { bySection, rest, tracked, snoozed, waiting } = useMemo(() => {
    const sorted = sessions.filter((s) => !isArchived(s)).sort(compareInbox);
    const bySection = new Map<number, SessionSummary[]>();
    const rest = { working: 0, quiet: 0, snoozed: 0, waiting: 0 };
    const snoozed: SessionSummary[] = [];
    const waiting: SessionSummary[] = [];
    let tracked = 0;
    for (const s of sorted) {
      const rank = inboxRank(s);
      if (s.attention || rank === 2) tracked++;
      if (rank === 6) snoozed.push(s);
      else if (rank === 7) waiting.push(s);
      else if (rank === 3) rest.working++;
      else if (rank > 3) rest.quiet++;
      else bySection.set(rank, [...(bySection.get(rank) ?? []), s]);
    }
    rest.snoozed = snoozed.length;
    rest.waiting = waiting.length;
    return { bySection, rest, tracked, snoozed, waiting };
  }, [sessions]);
  const [snoozeMenu, setSnoozeMenu] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [untilFor, setUntilFor] = useState<SessionSummary | null>(null);
  const runSnooze = (fn: () => Promise<unknown>) => {
    setSnoozeError(null);
    fn().catch((err: Error) => setSnoozeError(err.message));
  };

  const waitingCount = SECTIONS.reduce((n, sec) => n + (bySection.get(sec.rank)?.length ?? 0), 0);
  const restParts = inboxRestParts(rest);
  // "2 snoozed" / "1 waiting on others" open a short list: until when (Unsnooze), and on what.
  const [restOpen, setRestOpen] = useState<'snoozed' | 'waiting' | null>(null);
  const name = (s: SessionSummary) => (s.titleIsYours && s.title ? s.title : s.branch);

  return (
    <div className="wd-dash-tab-pane wd-tab-inbox">
      <header className="wd-tab-header">
        <h1>
          Inbox{' '}
          {waitingCount > 0 && (
            <span className="wd-tab-header-muted">
              {waitingCount} need{waitingCount === 1 ? 's' : ''} you
            </span>
          )}
        </h1>
        <NotificationOffer />
      </header>
      {tracked === 0 ? (
        <div className="wd-tab-empty">
          No session has reported its status yet. Status comes from Claude&apos;s hooks, which the full <code>work web</code> installs (not
          the lean one <code>wd</code> starts) — they apply to Claudes started, or prompted, after that.
        </div>
      ) : waitingCount === 0 ? (
        <div className="wd-tab-empty">Nothing needs you right now.</div>
      ) : (
        SECTIONS.filter((sec) => bySection.get(sec.rank)?.length).map((sec) => (
          <section key={sec.rank} className={`wd-inbox-section wd-inbox-rank-${sec.rank}`}>
            <h2 className="wd-inbox-section-title" title={sec.hint}>
              {sec.title} · {bySection.get(sec.rank)!.length}
              {sec.rank === 1 && onReviewAll && (
                <button
                  type="button"
                  className="wd-link-button wd-inbox-review-all"
                  onClick={onReviewAll}
                  title="Walk them one by one, each on what its last instruction changed (n for next)"
                >
                  Review all
                </button>
              )}
            </h2>
            <ul className="wd-inbox-list">
              {bySection.get(sec.rank)!.map((s) => {
                const request = sec.rank === 0 ? s.attention!.request : undefined;
                const canAnswer = !!request && s.ptyStatus === 'running' && agentCan(s, 'answer');
                const open = () => onOpenSession(s.id, sec.open, sec.rank === 1 ? { lastTurn: true } : undefined);
                return (
                  <li key={s.id} className="wd-inbox-item">
                    <button
                      type="button"
                      className="wd-inbox-row"
                      onClick={open}
                      title={`Open ${s.target} · ${s.branch} (${sec.open === 'term' ? 'terminal' : 'diff'})`}
                    >
                      <StatusIcon kind={sec.kind} />
                      <span className="wd-inbox-name">
                        <span className="wd-inbox-branch">{s.titleIsYours && s.title ? s.title : s.branch}</span>
                        <span className="wd-inbox-target">{s.target}</span>
                      </span>
                      <span className="wd-inbox-summary">
                        {answerError[s.id] ? (
                          <span className="wd-inbox-answer-error" role="alert">
                            {answerError[s.id]}
                          </span>
                        ) : sec.rank === 2 ? (
                          <>
                            {s.openReviewThreads} open thread{s.openReviewThreads === 1 ? '' : 's'}
                            {s.replyDrafts ? ` · ${s.replyDrafts} ${s.replyDrafts === 1 ? 'reply' : 'replies'} ready to post` : ''}
                          </>
                        ) : request ? (
                          <code className="wd-inbox-request" title={`${request.tool}: ${request.detail}`}>
                            <span className="wd-inbox-request-tool">{request.tool}</span> {request.detail}
                          </code>
                        ) : (
                          (s.attention!.summary ?? '')
                        )}
                      </span>
                      <span className="wd-inbox-since">{relativeTime(sec.rank === 2 ? lastActiveAt(s) : s.attention!.since)}</span>
                    </button>
                    <span className="wd-inbox-actions">
                      {/* On hover: what you do now and then. */}
                      <span className="wd-inbox-more">
                        {sec.rank === 1 && (
                          <button
                            type="button"
                            className="wd-link-button"
                            disabled={marking.has(s.id)}
                            onClick={() => markSeen(s.id)}
                            title="Clear it from the inbox without opening it"
                          >
                            {marking.has(s.id) ? 'Marking…' : 'Mark seen'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="wd-link-button"
                          title="Out of the Inbox for a while, or until it changes"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setSnoozeMenu({ s, x: r.left, y: r.bottom + 2 });
                          }}
                        >
                          Snooze
                        </button>
                        {sec.open !== 'term' && (
                          <button type="button" className="wd-link-button" onClick={() => onOpenSession(s.id, 'term')}>
                            Terminal
                          </button>
                        )}
                      </span>
                      {canAnswer ? (
                        <>
                          <button
                            type="button"
                            className="wd-row-action wd-row-action-allow"
                            disabled={!!answering[s.id]}
                            onClick={() => answer(s, 'allow')}
                            title="Press Yes in its terminal — only if the prompt on screen is still this one"
                          >
                            {answering[s.id] === 'allow' ? 'Allowing…' : 'Allow'}
                          </button>
                          <button
                            type="button"
                            className="wd-row-action wd-row-action-danger"
                            disabled={!!answering[s.id]}
                            onClick={() => answer(s, 'deny')}
                            title={`Say No; ${agentName(s)} stops and waits for you to say what to do instead`}
                          >
                            {answering[s.id] === 'deny' ? 'Denying…' : 'Deny'}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="wd-row-action" onClick={open}>
                          {sec.action}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      {snoozeError && <div className="wd-tab-empty wd-tab-error">{snoozeError}</div>}
      {tracked > 0 && restParts.length > 0 && (
        <p className="wd-inbox-rest">
          {restParts.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ', '}
              {p.key === 'snoozed' || p.key === 'waiting' ? (
                <button
                  type="button"
                  className="wd-link-button"
                  aria-expanded={restOpen === p.key}
                  onClick={() => setRestOpen((o) => (o === p.key ? null : (p.key as 'snoozed' | 'waiting')))}
                >
                  {p.text}
                </button>
              ) : (
                p.text
              )}
            </span>
          ))}{' '}
          — {restTail(rest)}
        </p>
      )}
      {restOpen === 'snoozed' && snoozed.length > 0 && (
        <ul className="wd-inbox-rest-list" aria-label="Snoozed">
          {snoozed.map((s) => (
            <li key={s.id}>
              <button type="button" className="wd-link-button" onClick={() => onOpenSession(s.id, 'term')}>
                {name(s)}
              </button>{' '}
              <span className="wd-inbox-target">{s.target}</span> <span className="wd-inbox-since">{snoozeLabel(s.snoozed!)}</span>{' '}
              <button type="button" className="wd-link-button" onClick={() => runSnooze(() => unsnoozeSession(s.id))}>
                Unsnooze
              </button>
            </li>
          ))}
        </ul>
      )}
      {restOpen === 'waiting' && waiting.length > 0 && (
        <ul className="wd-inbox-rest-list" aria-label="Waiting on others">
          {waiting.map((s) => (
            <li key={s.id}>
              <button type="button" className="wd-link-button" onClick={() => onOpenSession(s.id, 'term')}>
                {name(s)}
              </button>{' '}
              <span className="wd-inbox-target">{s.target}</span>{' '}
              <span className="wd-inbox-since">waits on {(s.blockedBy ?? []).map((b) => b.label).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {snoozeMenu && (
        <RowMenu
          x={snoozeMenu.x}
          y={snoozeMenu.y}
          onClose={() => setSnoozeMenu(null)}
          items={[
            { label: '2 hours', run: () => runSnooze(() => snoozeSession(snoozeMenu.s, '2h')) },
            { label: 'Until tomorrow 9:00', run: () => runSnooze(() => snoozeSession(snoozeMenu.s, 'tomorrow')) },
            { label: 'Until it changes', run: () => runSnooze(() => snoozeSession(snoozeMenu.s, 'change')) },
            { label: 'Until…', run: () => setUntilFor(snoozeMenu.s) },
          ]}
        />
      )}
      {untilFor && (
        <SnoozeUntilDialog
          onClose={() => setUntilFor(null)}
          onPick={(until) => {
            const x = untilFor;
            setUntilFor(null);
            runSnooze(() => snoozeSession(x, { until }));
          }}
        />
      )}
    </div>
  );
}
