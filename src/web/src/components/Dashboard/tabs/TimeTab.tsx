import { useCallback, useEffect, useState } from 'react';
import type {
  TimeDaySummary,
  TimeDaysWire,
  TimeDayWire,
  TimeEntryWire,
  TimeGraphWire,
  TimePostWire,
} from '../../../../../core/api-types.js';
import {
  connectTimeGraph,
  disconnectTimeGraph,
  fetchTimeDay,
  fetchTimeDays,
  fetchTimeGraph,
  postTimeDay,
  rebuildTimeDay,
  saveTimeDay,
} from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';

/** "Thu 8 Oct". Pure. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "2.5 h". Pure. */
export function hoursText(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;
}

/** A day's status in a word. Pure. */
export function statusText(s: TimeDaySummary['status']): string {
  return {
    empty: 'not gathered yet',
    draft: 'suggested',
    edited: 'edited',
    off: 'day off',
    'not-workday': 'weekend / holiday',
    posted: 'in Tempo',
    changed: 'changed since posted',
  }[s];
}

/** What a post did, in a line. Pure. */
export function postOutcome(r: Omit<TimePostWire, 'day'>): string {
  const parts = [
    r.posted && `${r.posted} posted`,
    r.removed && `${r.removed} removed`,
    r.kept && `${r.kept} already there`,
    r.coveredByHand && `${r.coveredByHand} you had logged by hand`,
  ].filter(Boolean);
  const head = parts.length ? `Tempo: ${parts.join(', ')}.` : 'Tempo already had the day as it is.';
  const other = r.otherByHand ? ` ${r.otherByHand} other worklog${r.otherByHand === 1 ? '' : 's'} of yours that day left alone.` : '';
  const failed = r.failed.length ? ` Not posted: ${r.failed.map((f) => `${f.key} (${f.error})`).join('; ')}.` : '';
  return head + other + failed;
}

const sameRows = (a: readonly TimeEntryWire[], b: readonly TimeEntryWire[]) =>
  a.length === b.length && a.every((e, i) => e.key === b[i].key && e.hours === b[i].hours);

/**
 * Time: each workday's hours per ticket, as work suggests them from what
 * you did (Claude's time per session, your commits, the issues you moved)
 * — kept current as you go — and as you change them. A day goes to Tempo
 * only when you click Post (tempo.ts reads Tempo's day first).
 */
export function TimeTab({
  onOpenSession,
  onDayChange,
  onAsk,
}: {
  onOpenSession: (id: string) => void;
  /** The day on screen (the assistant is told about it). */
  onDayChange?: (day: string | null) => void;
  /** Open the Ctrl+K assistant on this day. */
  onAsk?: () => void;
}) {
  const [days, setDays] = useState<TimeDaysWire | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [day, setDay] = useState<TimeDayWire | null>(null);
  const [rows, setRows] = useState<TimeEntryWire[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const loadDays = useCallback(() => {
    fetchTimeDays().then(
      (d) => {
        setDays(d);
        setChosen((c) => c ?? d.days[0]?.day ?? null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const loadDay = useCallback((d: string) => {
    fetchTimeDay(d).then(
      (w) => {
        setDay(w);
        setRows(w.entries);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => loadDays(), [loadDays]);
  useEffect(() => {
    setOutcome(null);
    if (chosen) loadDay(chosen);
    onDayChange?.(chosen);
  }, [chosen, loadDay, onDayChange]);
  useSse('/events', {
    events: {
      'time-changed': () => {
        loadDays();
        // Don't pull rows from under an edit in progress.
        if (chosen && (!day || sameRows(rows, day.entries))) loadDay(chosen);
      },
    },
  });

  const act = (p: Promise<TimeDayWire>) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    p.then(
      (w) => {
        setDay(w);
        setRows(w.entries);
        loadDays();
      },
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(false));
  };

  const post = () => {
    if (!day) return;
    setBusy(true);
    setError(null);
    postTimeDay(day.day)
      .then(
        (r) => {
          setDay(r.day);
          setRows(r.day.entries);
          setOutcome(postOutcome(r));
          loadDays();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };

  const dirty = !!day && !sameRows(rows, day.entries);
  const total = Math.round(rows.reduce((n, r) => n + (Number.isFinite(r.hours) ? r.hours : 0), 0) * 100) / 100;
  const step = day?.settings.stepHours ?? 0.25;
  const setRow = (i: number, change: Partial<TimeEntryWire>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)));

  return (
    <div className="wd-dash-tab-pane wd-tab-time">
      <header className="wd-tab-header">
        <h1>Time</h1>
        {days && (
          <p className="wd-time-rules">
            {hoursText(days.settings.dayHours)} a day · Claude time ×{days.settings.multiplier} · {hoursText(days.settings.stepHours)} steps
            {days.settings.gapTicket ? ` · the rest to ${days.settings.gapTicket}` : ''}
          </p>
        )}
      </header>
      <GraphLine />
      {days && !days.settings.gapTicket && (
        <p className="wd-time-hint">
          No ticket for the rest of the day is set, so it stays unallocated. Set <code>time.gapTicket</code> (and{' '}
          <code>time.timeOffTicket</code>) in config.json.
        </p>
      )}
      {error && (
        <p className="wd-time-error" role="alert">
          {error}
        </p>
      )}
      <div className="wd-time-body">
        <ul className="wd-time-days" aria-label="Days">
          {days === null && <li className="wd-time-note">Loading…</li>}
          {days?.days.map((d) => (
            <li key={d.day}>
              <button
                type="button"
                className={'wd-time-day' + (d.day === chosen ? ' wd-time-day-on' : '')}
                aria-current={d.day === chosen}
                onClick={() => setChosen(d.day)}
              >
                <span className="wd-time-day-date">{dayLabel(d.day)}</span>
                <span className={`wd-time-day-status wd-time-status-${d.status}`}>{statusText(d.status)}</span>
                <span className="wd-time-day-total">{d.total ? hoursText(d.total) : '—'}</span>
              </button>
            </li>
          ))}
        </ul>

        {day && (
          <section className="wd-time-detail" aria-label={`Hours on ${dayLabel(day.day)}`}>
            <div className="wd-time-detail-head">
              <h2>{dayLabel(day.day)}</h2>
              <span className={`wd-time-day-status wd-time-status-${day.status}`}>{statusText(day.status)}</span>
              <span className="wd-time-spacer" />
              <label className="wd-time-off">
                <input
                  type="checkbox"
                  checked={day.dayOff}
                  disabled={busy}
                  onChange={(e) => act(saveTimeDay(day.day, { dayOff: e.target.checked }))}
                />
                Day off
              </label>
              <button
                type="button"
                className="wd-btn-secondary"
                disabled={busy}
                onClick={() => act(rebuildTimeDay(day.day))}
                title="Look at the day's sessions, commits and Jira again"
              >
                Gather again
              </button>
              {onAsk && (
                <button
                  type="button"
                  className="wd-btn-secondary"
                  onClick={onAsk}
                  title="Talk the day over with the assistant (Ctrl+K): it sees the rows and why"
                >
                  Ask about this day
                </button>
              )}
            </div>

            <table className="wd-time-rows">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Title</th>
                  <th className="wd-time-num">Hours</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        className="wd-time-key"
                        value={r.key}
                        aria-label="Ticket"
                        disabled={busy || day.dayOff}
                        onChange={(e) => setRow(i, { key: e.target.value.toUpperCase() })}
                      />
                    </td>
                    <td className="wd-time-title">{day.titles[r.key] ?? ''}</td>
                    <td className="wd-time-num">
                      <input
                        type="number"
                        className="wd-time-hours"
                        aria-label={`Hours on ${r.key}`}
                        min={step}
                        step={step}
                        value={Number.isFinite(r.hours) ? r.hours : ''}
                        disabled={busy || day.dayOff}
                        onChange={(e) => setRow(i, { hours: e.target.valueAsNumber })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="wd-link-button"
                        aria-label={`Remove ${r.key}`}
                        disabled={busy || day.dayOff}
                        onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    {!day.dayOff && (
                      <button
                        type="button"
                        className="wd-link-button"
                        disabled={busy}
                        onClick={() => setRows((rs) => [...rs, { key: '', hours: step * 2 }])}
                      >
                        + Add a ticket
                      </button>
                    )}
                  </td>
                  <td className="wd-time-total-label">Total</td>
                  <td className={'wd-time-num' + (total !== day.settings.dayHours ? ' wd-time-off-total' : '')}>
                    {hoursText(total)} / {hoursText(day.settings.dayHours)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            <div className="wd-time-actions">
              <button
                type="button"
                className="wd-btn-primary"
                disabled={busy || !dirty}
                onClick={() => act(saveTimeDay(day.day, { entries: rows }))}
              >
                Save
              </button>
              {dirty && (
                <button type="button" className="wd-btn-secondary" disabled={busy} onClick={() => setRows(day.entries)}>
                  Undo changes
                </button>
              )}
              {day.edited && !dirty && (
                <button
                  type="button"
                  className="wd-btn-secondary"
                  disabled={busy}
                  onClick={() => act(saveTimeDay(day.day, { entries: null }))}
                >
                  Back to the suggestion
                </button>
              )}
              <button
                type="button"
                className="wd-btn-primary"
                disabled={busy || dirty || !day.posting?.ready || !day.entries.length || day.status === 'posted'}
                onClick={post}
                title={
                  dirty
                    ? 'Save your changes first'
                    : !day.posting?.ready
                      ? (day.posting?.why ?? 'Posting is not set up')
                      : day.status === 'posted'
                        ? 'Tempo has the day as it is'
                        : 'Make the day in Tempo what you see here: worklogs you made by hand are left alone'
                }
              >
                {day.posted ? 'Post again' : 'Post to Tempo'}
              </button>
              {day.edited && (
                <span className="wd-time-note">
                  Suggested: {day.suggested.map((e) => `${e.key} ${hoursText(e.hours)}`).join(', ') || 'nothing'}
                </span>
              )}
            </div>
            {day.posting && !day.posting.ready && <p className="wd-time-note">{day.posting.why}</p>}
            {day.posted && (
              <p className="wd-time-note">
                Posted {new Date(day.posted.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                {day.status === 'changed' ? ': changed since, post again to update Tempo.' : '.'}
              </p>
            )}
            {outcome && (
              <p className="wd-time-outcome" role="status">
                {outcome}
              </p>
            )}

            <Evidence day={day} onOpenSession={onOpenSession} />
          </section>
        )}
      </div>
    </div>
  );
}

function Evidence({ day, onOpenSession }: { day: TimeDayWire; onOpenSession: (id: string) => void }) {
  const ev = day.evidence;
  const meetings = ev.meetings ?? [];
  const chats = ev.chats ?? [];
  if (!ev.sessions.length && !ev.commits.length && !ev.jira.length && !meetings.length && !chats.length)
    return (
      <p className="wd-time-note">
        {day.builtAt ? 'Nothing found for this day.' : 'Not gathered yet: work does it in the background, or Gather again.'}
      </p>
    );
  const ticket = (key: string | null | undefined, guessed?: true, none = 'no ticket') => (
    <span className="wd-time-ev-key">
      {key ?? none}
      {guessed && (
        <span className="wd-time-ai" title="Placed by the AI step: nothing in it named a ticket">
          AI
        </span>
      )}
    </span>
  );
  return (
    <div className="wd-time-evidence">
      <h3>Why</h3>
      {ev.sessions.length > 0 && (
        <ul aria-label="Sessions">
          {ev.sessions.map((s) => (
            <li key={s.sessionId}>
              <button type="button" className="wd-link-button" onClick={() => onOpenSession(s.sessionId)}>
                {s.label}
              </button>{' '}
              {ticket(s.key, s.guessed)} · {s.minutes} min of Claude
            </li>
          ))}
        </ul>
      )}
      {ev.commits.length > 0 && (
        <ul aria-label="Commits">
          {ev.commits.map((c) => (
            <li key={c.sha}>
              {ticket(c.keys.join(', ') || null, c.guessed)} {c.repo}: {c.subject}
            </li>
          ))}
        </ul>
      )}
      {ev.jira.length > 0 && (
        <ul aria-label="Jira">
          {ev.jira.map((j) => (
            <li key={j.key}>
              {ticket(j.key)} {j.summary} — {j.what}
            </li>
          ))}
        </ul>
      )}
      {meetings.length > 0 && (
        <ul aria-label="Meetings">
          {meetings.map((m, i) => (
            <li key={i}>
              {ticket(m.key, m.guessed, day.settings.gapTicket ?? 'no ticket')} {m.start}–{m.end} {m.subject} · {m.minutes} min
            </li>
          ))}
        </ul>
      )}
      {chats.length > 0 && (
        <ul aria-label="Chats">
          {chats.map((c, i) => (
            <li key={i}>
              {ticket(c.key, c.guessed)} Teams: {c.chat} · {c.messages} message{c.messages === 1 ? '' : 's'} of yours
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Outlook and Teams: connect (a code to enter at Microsoft), signed in as, or why it can't. */
function GraphLine() {
  const [g, setG] = useState<TimeGraphWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchTimeGraph().then(setG, () => setG(null));
  }, []);
  useEffect(() => load(), [load]);
  useSse('/events', { events: { 'time-graph-changed': load } });
  const run = (p: Promise<TimeGraphWire>) => {
    setBusy(true);
    setError(null);
    p.then(setG, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (!g) return null;
  return (
    <p className="wd-time-graph">
      Outlook &amp; Teams:{' '}
      {g.account ? (
        <>
          meetings and chats from <strong>{g.account}</strong>{' '}
          <button type="button" className="wd-link-button" disabled={busy} onClick={() => run(disconnectTimeGraph())}>
            Disconnect
          </button>
        </>
      ) : g.login ? (
        <>
          enter <strong className="wd-time-code">{g.login.userCode}</strong> at{' '}
          <a href={g.login.verificationUri} target="_blank" rel="noreferrer">
            {g.login.verificationUri.replace(/^https:\/\//, '')}
          </a>{' '}
          to connect (waiting…)
        </>
      ) : g.ready ? (
        <>
          not connected{' '}
          <button type="button" className="wd-link-button" disabled={busy} onClick={() => run(connectTimeGraph())}>
            Connect
          </button>
          {g.error && <span className="wd-time-error-inline"> · {g.error}</span>}
        </>
      ) : (
        <span>{g.why}</span>
      )}
      {error && <span className="wd-time-error-inline"> · {error}</span>}
    </p>
  );
}
