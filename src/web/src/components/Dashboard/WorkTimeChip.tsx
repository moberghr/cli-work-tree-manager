import { useEffect, useRef, useState } from 'react';
import { fetchWorkTime, type SessionSummary, type WorkTime } from '../../api/client.js';
import { dayKey, formatWorked, worklogTime } from '../../../../core/work-time-view.js';

/** Look again at most this often while the session is open (it reads transcripts). */
const REFRESH_MS = 60_000;

/** "PROJ-123 1h 15m — Payments retry": today's work if any, else all of it. Pure. */
export function worklogLine(s: Pick<SessionSummary, 'jiraKey' | 'title' | 'branch'>, t: WorkTime, now = Date.now()): { text: string; today: boolean } {
  const today = t.byDay.find((d) => d.day === dayKey(now))?.ms ?? 0;
  const ms = today || t.workedMs;
  return { text: `${s.jiraKey ? `${s.jiraKey} ` : ''}${worklogTime(ms)} — ${s.title || s.branch}`, today: today > 0 };
}

function weekday(day: string, now: number): string {
  if (day === dayKey(now)) return 'Today';
  if (day === dayKey(now - 24 * 3_600_000)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * In the session strip: how long its Claude worked (work-time.ts) — "⏱ 1h 20m",
 * per day in the tooltip. Click copies a worklog line (today's, with the Jira
 * key when it has one); work can't write Jira worklogs itself (acli has no
 * worklog command), so it's for pasting.
 */
export function WorkTimeChip({ session }: { session: SessionSummary }) {
  const [time, setTime] = useState<WorkTime | null>(null);
  const [copied, setCopied] = useState(false);
  const last = useRef<{ id: string; at: number } | null>(null);
  const activity = session.lastActivity;
  useEffect(() => {
    const now = Date.now();
    // Another session: at once. The same one: when its conversation moved, at most once a minute.
    if (last.current?.id === session.id && now - last.current.at < REFRESH_MS) return;
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
  }, [session.id, activity]);
  if (!time || time.workedMs < 60_000) return null;
  const now = Date.now();
  const line = worklogLine(session, time, now);
  const days = time.byDay.slice(0, 7).map((d) => `${weekday(d.day, now)} ${formatWorked(d.ms)}`).join(' · ');
  const copy = () =>
    void navigator.clipboard.writeText(line.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  return (
    <button
      type="button"
      className="wd-work-time"
      onClick={copy}
      title={
        `Its Claude worked about ${formatWorked(time.workedMs)} over ${time.prompts} prompt${time.prompts === 1 ? '' : 's'}` +
        ' (the time between its steps, at most 15 minutes each — your reading and typing time is not counted).' +
        (days ? `\n${days}` : '') +
        `\nClick to copy ${line.today ? "today's" : 'the'} worklog: ${line.text}`
      }
    >
      <span aria-hidden>⏱</span> {copied ? 'Copied' : formatWorked(time.workedMs)}
    </button>
  );
}
