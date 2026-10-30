import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimeMonthWire } from '../../../../../core/api-types.js';
import { fetchTimeMonth, gatherTimeMonth, postTimeDay } from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';
import { dayLabel, hoursText, leftOutText, monthPostSummary, statusText, type MonthPostResult } from '../../../state/time-month.js';

/**
 * The Time tab's Month view: the month up to today as tickets × days, and
 * Post the month — every day that's ready, one after another through the
 * day's own post (Tempo's day read first, as for one day), after a confirm
 * that shows what goes and what stays out.
 */
export function TimeMonth({ month, onOpenDay }: { month: string; onOpenDay: (day: string) => void }) {
  const [m, setM] = useState<TimeMonthWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; day: string; stopping: boolean } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const stop = useRef(false);
  // The month on screen: an answer for another one (a slow fetch from before ‹ ›) isn't shown.
  const monthRef = useRef(month);
  monthRef.current = month;

  const load = useCallback(() => {
    fetchTimeMonth(month).then(
      (w) => {
        if (w.month === monthRef.current) setM(w);
      },
      (e: Error) => setError(e.message),
    );
  }, [month]);
  useEffect(() => {
    setM(null);
    setError(null);
    setSummary(null);
    load();
  }, [load]);
  useSse('/events', { events: { 'time-changed': load } });

  const gather = () => {
    setError(null);
    gatherTimeMonth(month).then(
      (w) => {
        if (w.month === monthRef.current) setM(w);
      },
      (e: Error) => setError(e.message),
    );
  };

  const postMonth = async (days: readonly string[]) => {
    setConfirming(false);
    setSummary(null);
    stop.current = false;
    const results: MonthPostResult[] = [];
    for (const [i, day] of days.entries()) {
      if (stop.current) break;
      setProgress((p) => ({ done: i, total: days.length, day, stopping: p?.stopping ?? false }));
      try {
        const r = await postTimeDay(day);
        results.push({ day, hours: r.day.total, failed: r.failed });
      } catch (err) {
        results.push({ day, hours: 0, error: (err as Error).message });
      }
    }
    setProgress(null);
    setSummary(monthPostSummary(results, days.length, dayLabel));
    load();
  };

  if (error && !m)
    return (
      <p className="wd-time-error" role="alert">
        {error}
      </p>
    );
  if (!m) return <p className="wd-time-note wd-time-month-pad">Loading…</p>;

  const plan = m.plan;
  // Days in Tempo already are said by their dots (and counted in the confirm): the list is what needs you.
  const leftOut = plan.leftOut.filter((l) => l.why !== 'posted');
  const inTempo = plan.leftOut.length - leftOut.length;
  const posting = !!progress;
  const canPost = !!m.posting?.ready && plan.days.length > 0 && !posting;
  return (
    <section className="wd-time-month" aria-label="The month">
      <div className="wd-time-month-bar">
        <span className="wd-time-note">
          {m.days.filter((d) => d.status === 'posted').length} of {m.days.length} days in Tempo · {plan.days.length} ready ·{' '}
          {hoursText(plan.total)} to post
        </span>
        <span className="wd-time-spacer" />
        {m.missing > 0 && (
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={!!m.gathering}
            onClick={gather}
            title="Look at those days' sessions, commits, Jira and meetings"
          >
            {m.gathering ? 'Gathering…' : `Gather ${m.missing} day${m.missing === 1 ? '' : 's'}`}
          </button>
        )}
        <button
          type="button"
          className="wd-btn-primary"
          disabled={!canPost}
          onClick={() => setConfirming(true)}
          title={
            !m.posting?.ready ? (m.posting?.why ?? 'Posting is not set up') : !plan.days.length ? 'No day is ready to post' : undefined
          }
        >
          Post {plan.days.length} day{plan.days.length === 1 ? '' : 's'} to Tempo…
        </button>
      </div>
      {m.gatherError && <p className="wd-time-error-inline wd-time-month-pad">{m.gatherError}</p>}
      {error && (
        <p className="wd-time-error-inline wd-time-month-pad" role="alert">
          {error}
        </p>
      )}
      {progress && (
        <div className="wd-time-month-progress" role="status">
          <span>
            Posting {progress.done + 1} of {progress.total} · {dayLabel(progress.day)}
          </span>
          <progress max={progress.total} value={progress.done} aria-label="Days posted" />
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={progress.stopping}
            onClick={() => {
              stop.current = true;
              setProgress((p) => (p ? { ...p, stopping: true } : p));
            }}
          >
            {progress.stopping ? 'Stopping after this day…' : 'Stop after this day'}
          </button>
        </div>
      )}
      {summary && (
        <p className="wd-time-outcome wd-time-month-pad" role="status">
          {summary}
        </p>
      )}

      {m.days.length === 0 ? (
        <p className="wd-time-note wd-time-month-pad">Nothing gathered for this month yet.</p>
      ) : (
        <div className="wd-time-grid-box">
          <table className="wd-time-grid">
            <thead>
              <tr>
                <th className="wd-time-grid-key">Ticket</th>
                <th className="wd-time-grid-title">Title</th>
                {m.days.map((d) => (
                  <th key={d.day} className={'wd-time-grid-day' + (d.today ? ' wd-time-grid-today' : '')}>
                    <button
                      type="button"
                      className="wd-time-grid-open"
                      onClick={() => onOpenDay(d.day)}
                      title={`${dayLabel(d.day)}: ${d.today ? 'today' : statusText(d.status)}. Open it`}
                    >
                      <span>{new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
                      <span className="wd-time-grid-num">{Number(d.day.slice(8))}</span>
                      <span className={`wd-time-dot wd-time-dot-${d.status}`} aria-hidden="true" />
                    </button>
                  </th>
                ))}
                <th className="wd-time-num">Month</th>
              </tr>
            </thead>
            <tbody>
              {m.tickets.map((t) => (
                <tr key={t.key}>
                  <td className="wd-time-grid-key">{t.key}</td>
                  <td className="wd-time-grid-title" title={t.title}>
                    {t.title}
                    {t.placeholder && (
                      <span className="wd-time-tag wd-time-tag-warn" title="A placeholder in time.hints: create the ticket in Jira first">
                        create first
                      </span>
                    )}
                  </td>
                  {m.days.map((d) => {
                    const h = d.entries.find((e) => e.key === t.key)?.hours;
                    return (
                      <td
                        key={d.day}
                        className={
                          'wd-time-grid-cell' +
                          (d.today ? ' wd-time-grid-today' : '') +
                          (d.status === 'posted' && h ? ' wd-time-grid-posted' : '')
                        }
                        title={h ? `${t.key} on ${dayLabel(d.day)}: ${d.why?.[t.key] || `${hoursText(h)}`}` : undefined}
                      >
                        {h ?? ''}
                      </td>
                    );
                  })}
                  <td className="wd-time-num">{hoursText(t.hours)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="wd-time-grid-key">Total</td>
                <td />
                {m.days.map((d) => (
                  <td
                    key={d.day}
                    className={
                      'wd-time-grid-cell' +
                      (d.today ? ' wd-time-grid-today' : '') +
                      (!d.today && d.total !== m.settings.dayHours ? ' wd-time-off-total' : '')
                    }
                    title={
                      !d.today && d.total !== m.settings.dayHours ? `${hoursText(d.total)} of ${hoursText(m.settings.dayHours)}` : undefined
                    }
                  >
                    {d.total || ''}
                  </td>
                ))}
                <td className="wd-time-num">{hoursText(m.tickets.reduce((n, t) => n + t.hours, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="wd-time-legend">
        <span>
          <span className="wd-time-dot wd-time-dot-posted" /> in Tempo
        </span>
        <span>
          <span className="wd-time-dot wd-time-dot-changed" /> changed since posted
        </span>
        <span>
          <span className="wd-time-dot wd-time-dot-edited" /> edited
        </span>
        <span>
          <span className="wd-time-dot wd-time-dot-draft" /> suggested
        </span>
        <span>Amber total: not the day&apos;s {hoursText(m.settings.dayHours)} · a day&apos;s column opens it</span>
      </p>

      {leftOut.length > 0 && (
        <div className="wd-time-month-out">
          <h3>Not posted with the month</h3>
          <ul>
            {leftOut.map((l) => (
              <li key={l.day}>
                {dayLabel(l.day)}: {leftOutText(l.why)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <div
          className="wd-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Post the month to Tempo"
          onClick={(e) => e.target === e.currentTarget && setConfirming(false)}
          onKeyDown={(e) => e.key === 'Escape' && setConfirming(false)}
        >
          <div className="wd-modal">
            <header className="wd-modal-header">
              <h2>
                Post {plan.days.length} day{plan.days.length === 1 ? '' : 's'} to Tempo?
              </h2>
              <button type="button" className="wd-modal-close" onClick={() => setConfirming(false)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="wd-modal-body">
              <p className="wd-time-note">
                Each day is made in Tempo as it shows here, one after another. Worklogs you made by hand in Tempo are left alone.
              </p>
              <table className="wd-time-rows">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Title</th>
                    <th className="wd-time-num">Hours</th>
                    <th className="wd-time-num">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.tickets.map((t) => (
                    <tr key={t.key}>
                      <td>{t.key}</td>
                      <td className="wd-time-title">{t.title}</td>
                      <td className="wd-time-num">{hoursText(t.hours)}</td>
                      <td className="wd-time-num">{t.days}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td />
                    <td className="wd-time-num">{hoursText(plan.total)}</td>
                    <td className="wd-time-num">{plan.days.length}</td>
                  </tr>
                </tfoot>
              </table>
              {(leftOut.length > 0 || inTempo > 0) && (
                <p className="wd-time-note">
                  Left out:{' '}
                  {[
                    ...leftOut.map((l) => `${dayLabel(l.day)} (${leftOutText(l.why)})`),
                    ...(inTempo ? [`${inTempo} day${inTempo === 1 ? '' : 's'} already in Tempo`] : []),
                  ].join(', ')}
                  .
                </p>
              )}
              {plan.short.length > 0 && (
                <p className="wd-time-off-total">
                  Not the day&apos;s {hoursText(m.settings.dayHours)}, posted as they are:{' '}
                  {plan.short.map((s) => `${dayLabel(s.day)} ${hoursText(s.total)}`).join(', ')}.
                </p>
              )}
            </div>
            <footer className="wd-modal-footer">
              <button type="button" className="wd-btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="wd-btn-primary" autoFocus onClick={() => void postMonth(plan.days)}>
                Post {plan.days.length} day{plan.days.length === 1 ? '' : 's'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
