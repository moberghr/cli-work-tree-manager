import { useEffect, useRef, useState } from 'react';
import { fetchWorklog, fetchWorkTime, logWorklog, type SessionSummary, type WorkTime } from '../../api/client.js';
import { dayKey, formatWorked, worklogTime } from '../../../../core/work-time-view.js';

/** Look again at most this often while the session is open (it reads transcripts). */
const REFRESH_MS = 60_000;

/**
 * "PROJ-123 1h 15m — Payments retry": a day's work, for a worklog — today's,
 * else the latest day it worked (in the last two weeks). Null when it hasn't
 * worked in that time: a lifetime total is no day's worklog. Pure.
 */
export function worklogLine(s: Pick<SessionSummary, 'jiraKey' | 'title' | 'branch'>, t: WorkTime): { text: string; day: string } | null {
  const d = t.byDay[0]; // newest first
  if (!d) return null;
  return { text: `${s.jiraKey ? `${s.jiraKey} ` : ''}${worklogTime(d.ms)} — ${s.title || s.branch}`, day: d.day };
}

function weekday(day: string, now: number): string {
  if (day === dayKey(now)) return 'Today';
  if (day === dayKey(now - 24 * 3_600_000)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * In the session strip: how long its Claude worked (work-time.ts) — "⏱ 1h 20m",
 * per day in the tooltip. Click copies a worklog line (the latest day's — usually
 * today's — with the Jira key when it has one); work can't write Jira worklogs itself (acli has no
 * worklog command), so it's for pasting.
 */
export function WorkTimeChip({ session }: { session: SessionSummary }) {
  const [time, setTime] = useState<WorkTime | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const last = useRef<{ id: string; at: number } | null>(null);
  const [tick, setTick] = useState(0);
  const activity = session.lastActivity;
  useEffect(() => {
    const now = Date.now();
    // Another session: at once. The same one: when its conversation moved, at
    // most once a minute — and a move inside that minute is caught up at its end.
    if (last.current?.id === session.id && now - last.current.at < REFRESH_MS) {
      const wait = setTimeout(() => setTick((n) => n + 1), REFRESH_MS - (now - last.current.at));
      return () => clearTimeout(wait);
    }
    if (last.current?.id !== session.id) setTime(null);
    last.current = { id: session.id, at: now };
    let live = true;
    fetchWorkTime(session.id).then(
      (t) => live && setTime(t),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session.id, activity, tick]);
  if (!time || time.workedMs < 60_000) return null;
  const now = Date.now();
  const line = worklogLine(session, time);
  const days = time.byDay.slice(0, 7).map((d) => `${weekday(d.day, now)} ${formatWorked(d.ms)}`).join(' · ');
  const flash = (what: 'ok' | 'failed') => {
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };
  const copy = () => {
    if (!line) return;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(line.text))
      .then(
        () => flash('ok'),
        () => flash('failed'),
      );
  };
  return (
    <span className="wd-work-time-wrap">
    <button
      type="button"
      className="wd-work-time"
      onClick={copy}
      disabled={!line}
      title={
        `Its Claude worked about ${formatWorked(time.workedMs)} over ${time.prompts} prompt${time.prompts === 1 ? '' : 's'}` +
        ' (the time between its steps, at most 15 minutes each — your reading and typing time is not counted).' +
        (days ? `\n${days}` : '') +
        (line ? `\nClick to copy ${weekday(line.day, now) === 'Today' ? "today's" : `${weekday(line.day, now)}'s`} worklog: ${line.text}` : '\nNo work in the last two weeks to log.')
      }
    >
      <span aria-hidden>⏱</span> {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : formatWorked(time.workedMs)}
    </button>
    {line && session.jiraKey && <LogToJira sessionId={session.id} day={line.day} jiraKey={session.jiraKey} />}
    </span>
  );
}

/**
 * "→ Jira": write the latest day's work to the session's Jira issue as a
 * worklog (core/jira-worklog.ts), when config `jiraWorklog` is set up. What
 * is already logged for that day isn't logged again; the rest is.
 */
function LogToJira({ sessionId, day, jiraKey }: { sessionId: string; day: string; jiraKey: string }) {
  const [state, setState] = useState<{ configured: boolean; logged: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    fetchWorklog(sessionId).then(
      (w) => live && setState({ configured: w.configured, logged: w.logged[day] ?? 0 }),
      () => live && setState(null),
    );
    return () => {
      live = false;
    };
  }, [sessionId, day]);
  if (!state?.configured) return null;
  const log = () => {
    setBusy(true);
    setResult(null);
    logWorklog(sessionId, day).then(
      (r) => {
        setBusy(false);
        setState({ configured: true, logged: r.total });
        setResult({ text: r.text });
      },
      (err: Error) => {
        setBusy(false);
        setResult({ text: err.message, error: true });
      },
    );
  };
  return (
    <>
      <button
        type="button"
        className="wd-work-time-jira"
        disabled={busy}
        onClick={log}
        title={`Write ${weekday(day, Date.now()) === 'Today' ? "today's" : `${day}'s`} work to ${jiraKey} as a worklog${state.logged ? ` (${worklogTime(state.logged * 1000)} logged already: only what was added since)` : ''}`}
      >
        {busy ? 'Logging…' : state.logged ? `→ ${jiraKey} ✓` : `→ ${jiraKey}`}
      </button>
      {result && (
        <span className={'wd-work-time-result' + (result.error ? ' wd-tab-error' : '')} role="status">
          {result.text}
        </span>
      )}
    </>
  );
}
