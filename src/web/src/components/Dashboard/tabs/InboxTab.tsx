import { useMemo, useState } from 'react';
import { SnoozeUntilDialog } from '../SnoozeUntilDialog.js';
import { RowMenu } from '../RowMenu.js';
import { snoozeLabel } from '../../../../../core/snooze.js';
import { useNotificationPermission } from '../../../hooks/use-presence.js';
import { answerPermission, markSessionSeen, setArchived, type AnswerRequest, type SessionSummary, snoozeSession, unsnoozeSession } from '../../../api/client.js';
import { isArchived, lastActiveAt, staleSuggestions, type PrLookup } from '../../../state/session-display.js';
import { DiffStatChip, OverlapChip, PrChips } from '../SessionBits.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import { compareInbox, inboxRank } from '../../../../../core/attention.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  /** Open a session on the sub-tab that fits why it's here: the terminal to
   *  answer a question, the diff to review finished work. */
  onOpenSession: (id: string, sub: SessionSubTab, opts?: { lastTurn?: boolean }) => void;
  /** Start the review queue over the Done section. */
  onReviewAll?: () => void;
  /** Open PRs for a session; rows skip the badge without it. */
  prsFor?: PrLookup;
  /** Whether `prsFor` is a full answer for a session (see staleSuggestions);
   *  without it nothing is suggested for archiving. */
  prsKnown?: (s: SessionSummary) => boolean;
  /** Clear a finished session's unseen flag without opening it. Defaults
   *  to the API call; injectable for tests. */
  onMarkSeen?: (id: string) => Promise<unknown>;
  /** Archive a session (the stale suggestions). Defaults to the API call. */
  onArchive?: (id: string) => Promise<unknown>;
  /** Allow / Deny a permission prompt. Defaults to the API call. */
  onAnswer?: (id: string, req: AnswerRequest) => Promise<unknown>;
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
  { rank: 2, title: 'Review comments', hint: 'Reviewers left comments on its PR that nobody has answered or resolved', since: 'last active', open: 'diff' },
  { rank: 3, title: 'Working', hint: 'Mid-turn', since: 'working', open: 'term' },
];
/** Sections that want you (the header count and the badge): needs input, done, review comments. */
const WAITING_RANKS = [0, 1, 2];

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
  prsKnown,
  onMarkSeen = markSessionSeen,
  onAnswer = answerPermission,
  onReviewAll,
  onArchive = (id) => setArchived(id, true),
}: Props) {
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
    onMarkSeen(id).finally(() =>
      setMarking((m) => {
        const next = new Set(m);
        next.delete(id);
        return next;
      }),
    );
  };
  const { bySection, quiet, tracked, snoozed } = useMemo(() => {
    const sorted = sessions.filter((s) => !isArchived(s)).sort(compareInbox);
    const bySection = new Map<number, SessionSummary[]>();
    const snoozed: SessionSummary[] = [];
    let quiet = 0;
    let tracked = 0;
    for (const s of sorted) {
      const rank = inboxRank(s);
      if (rank === 6) {
        snoozed.push(s);
        continue;
      }
      if (s.attention || rank === 2) tracked++;
      if (rank > 3) {
        if (s.attention) quiet++;
        continue;
      }
      bySection.set(rank, [...(bySection.get(rank) ?? []), s]);
    }
    return { bySection, quiet, tracked, snoozed };
  }, [sessions]);
  const [snoozeMenu, setSnoozeMenu] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [untilFor, setUntilFor] = useState<SessionSummary | null>(null);
  const runSnooze = (fn: () => Promise<unknown>) => {
    setSnoozeError(null);
    fn().catch((err: Error) => setSnoozeError(err.message));
  };

  const waitingCount = WAITING_RANKS.reduce((n, r) => n + (bySection.get(r)?.length ?? 0), 0);

  return (
    <div className="wd-dash-tab-pane wd-tab-inbox">
      <header className="wd-tab-header">
        <h1>
          Inbox{' '}
          <span className="wd-tab-header-muted">
            ({waitingCount} need{waitingCount === 1 ? 's' : ''} you · {bySection.get(3)?.length ?? 0} working
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
      ) : waitingCount === 0 && !bySection.get(3)?.length ? (
        <div className="wd-tab-empty">Nothing needs you right now.</div>
      ) : (
        SECTIONS.filter((sec) => bySection.get(sec.rank)?.length).map((sec) => (
          <section key={sec.rank} className={`wd-inbox-section wd-inbox-rank-${sec.rank}`}>
            <h2 className="wd-inbox-section-title" title={sec.hint}>
              {sec.title}{' '}
              <span className="wd-tab-header-muted">({bySection.get(sec.rank)!.length})</span>
              {sec.rank === 1 && onReviewAll && (
                <button
                  type="button"
                  className="wd-btn-secondary wd-inbox-review-all"
                  onClick={onReviewAll}
                  title="Walk them one by one, each on what its last instruction changed (n for next)"
                >
                  Review all
                </button>
              )}
            </h2>
            <ul className="wd-inbox-list">
              {bySection.get(sec.rank)!.map((s) => (
                <li key={s.id} className="wd-inbox-item">
                  <button
                    type="button"
                    className="wd-inbox-row"
                    onClick={() => onOpenSession(s.id, sec.open, sec.rank === 1 ? { lastTurn: true } : undefined)}
                    title={`Open ${s.target} · ${s.branch} (${sec.open === 'term' ? 'terminal' : 'diff'})`}
                  >
                    <span className={`wd-inbox-dot wd-inbox-dot-${sec.rank === 2 ? 'review' : s.attention!.state}`} aria-hidden />
                    <span className="wd-inbox-name">
                      <span className="wd-inbox-target">{s.target}</span>
                      <span className="wd-inbox-branch">{s.branch}</span>
                    </span>
                    <span className="wd-inbox-summary">
                      {answerError[s.id] ? (
                        <span className="wd-inbox-answer-error" role="alert">{answerError[s.id]}</span>
                      ) : sec.rank === 2 ? (
                        <span className="wd-inbox-review">
                          💬 {s.openReviewThreads} unresolved review comment{s.openReviewThreads === 1 ? '' : 's'}
                          {!!s.replyDrafts && (
                            <span className="wd-inbox-drafts" title="Claude drafted replies: review and post them in the session">
                              · ✍ {s.replyDrafts} {s.replyDrafts === 1 ? 'reply' : 'replies'} to post
                            </span>
                          )}
                        </span>
                      ) : s.attention!.state === 'needs_input' && s.attention!.request ? (
                        <span className="wd-inbox-request" title={`${s.attention!.request.tool}: ${s.attention!.request.detail}`}>
                          <span className="wd-inbox-request-tool">{s.attention!.request.tool}</span>{' '}
                          <code>{s.attention!.request.detail}</code>
                        </span>
                      ) : (
                        s.attention!.summary ?? <span className="wd-tab-header-muted">—</span>
                      )}
                    </span>
                    <span className="wd-inbox-meta">
                      <DiffStatChip session={s} />
                      <OverlapChip session={s} />
                      <PrChips prs={prsFor?.(s) ?? []} />
                      <span className="wd-inbox-since">
                        {sec.since} {relativeTime(sec.rank === 2 ? lastActiveAt(s) : s.attention!.since)}
                      </span>
                    </span>
                  </button>
                  <span className="wd-inbox-actions">
                    {sec.rank === 0 && s.attention!.request && s.ptyStatus === 'running' ? (
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
                          title="Say No; Claude stops and waits for you to say what to do instead"
                        >
                          {answering[s.id] === 'deny' ? 'Denying…' : 'Deny'}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="wd-row-action" onClick={() => onOpenSession(s.id, 'diff')}>
                        Diff
                      </button>
                    )}
                    <button type="button" className="wd-row-action" onClick={() => onOpenSession(s.id, 'term')}>
                      Terminal
                    </button>
                    {WAITING_RANKS.includes(sec.rank) && (
                      <button
                        type="button"
                        className="wd-row-action"
                        title="Out of the Inbox for a while, or until it changes"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setSnoozeMenu({ s, x: r.left, y: r.bottom + 2 });
                        }}
                      >
                        Snooze
                      </button>
                    )}
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
      {snoozeError && <div className="wd-tab-empty wd-tab-error">{snoozeError}</div>}
      {snoozed.length > 0 && (
        <section className="wd-inbox-section wd-inbox-snoozed">
          <h2 className="wd-inbox-section-title" title="Snoozed: out of the Inbox and its count until then, or until their status changes">
            Snoozed <span className="wd-tab-header-muted">({snoozed.length})</span>
          </h2>
          <ul className="wd-inbox-list">
            {snoozed.map((s) => (
              <li key={s.id} className="wd-inbox-item">
                <button type="button" className="wd-inbox-row" onClick={() => onOpenSession(s.id, 'diff')} title={`Open ${s.target} · ${s.branch}`}>
                  <span className="wd-inbox-name">
                    <span className="wd-inbox-target">{s.target}</span>
                    <span className="wd-inbox-branch">{s.branch}</span>
                  </span>
                  <span className="wd-inbox-summary">{s.attention?.summary ?? <span className="wd-tab-header-muted">—</span>}</span>
                  <span className="wd-inbox-meta">
                    <span className="wd-inbox-since">{snoozeLabel(s.snoozed!)}</span>
                  </span>
                </button>
                <span className="wd-inbox-actions">
                  <button type="button" className="wd-row-action" onClick={() => runSnooze(() => unsnoozeSession(s.id))}>
                    Unsnooze
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
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
      <StaleSuggestions sessions={sessions} prsFor={prsFor} prsKnown={prsKnown} onOpen={(id) => onOpenSession(id, 'diff')} onArchive={onArchive} />
    </div>
  );
}

const SNOOZE_KEY = 'wd-stale-snoozed';
const SNOOZE_MS = 14 * 24 * 60 * 60_000;
function readSnoozed(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Sessions nobody has touched for two weeks, with no open PR: suggested for
 * archiving (the conversation is kept; the worktree too when it has work in
 * it). "Not now" hides one for two weeks in this window.
 */
function StaleSuggestions({ sessions, prsFor, prsKnown, onOpen, onArchive }: { sessions: SessionSummary[]; prsFor?: PrLookup; prsKnown?: (s: SessionSummary) => boolean; onOpen: (id: string) => void; onArchive: (id: string) => Promise<unknown> }) {
  const [snoozed, setSnoozed] = useState<Record<string, number>>(readSnoozed);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const list = useMemo(() => staleSuggestions(sessions, prsFor, Date.now(), snoozed, prsKnown), [sessions, prsFor, snoozed, prsKnown]);
  if (list.length === 0) return null;
  const snooze = (ids: string[]) => {
    const next = { ...snoozed };
    for (const id of ids) next[id] = Date.now() + SNOOZE_MS;
    setSnoozed(next);
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
    } catch {
      /* private window: only for now */
    }
  };
  const archive = (ids: string[]) => {
    setBusy((b) => new Set([...b, ...ids]));
    void Promise.all(ids.map((id) => onArchive(id).catch(() => {}))).finally(() =>
      setBusy((b) => new Set([...b].filter((x) => !ids.includes(x)))),
    );
  };
  return (
    <section className="wd-inbox-section wd-inbox-stale">
      <h2 className="wd-inbox-section-title" title="Untouched for two weeks or more, no open PR, no Claude running">
        Worth archiving? <span className="wd-tab-header-muted">({list.length})</span>
        <button type="button" className="wd-row-action" onClick={() => archive(list.map((s) => s.id))} disabled={busy.size > 0}>
          Archive all
        </button>
      </h2>
      <p className="wd-cleanup-hint">Archiving keeps the conversation and removes the worktree when nothing would be lost; Restore brings it back.</p>
      <ul className="wd-inbox-list">
        {list.map((s) => (
          <li key={s.id} className="wd-inbox-item wd-inbox-stale-item">
            <button type="button" className="wd-inbox-row" onClick={() => onOpen(s.id)}>
              <span className="wd-inbox-target">{s.target}</span>
              <span className="wd-inbox-branch">{s.branch}</span>
              {s.title && <span className="wd-inbox-summary">{s.title}</span>}
              <span className="wd-inbox-when">{relativeTime(lastActiveAt(s))}</span>
            </button>
            <span className="wd-inbox-actions">
              <button type="button" className="wd-row-action" disabled={busy.has(s.id)} onClick={() => archive([s.id])}>
                {busy.has(s.id) ? 'Archiving…' : 'Archive'}
              </button>
              <button type="button" className="wd-row-action" onClick={() => snooze([s.id])} title="Hide it here for two weeks">
                Not now
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
