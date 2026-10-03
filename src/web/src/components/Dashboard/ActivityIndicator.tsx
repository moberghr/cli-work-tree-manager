import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityRun, ActivitySchedule, ActivityWire } from '../../../../core/api-types.js';
import { fetchActivity } from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { relativeTime } from '../../utils/time.js';
import { activityAttention, activityQuietLine, collapseRuns } from '../../state/activity-view.js';
import { VERSION } from '../../version.js';

interface Props {
  onOpenSession: (id: string) => void;
  /** Injectable for tests. */
  load?: () => Promise<ActivityWire>;
}

/** "in 1:05" / "now" until a time. */
export function countdown(iso: string, now: number): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return 'now';
  const m = Math.floor(s / 60);
  return m >= 60 ? `in ${Math.round(m / 60)} h` : `in ${m}:${String(s % 60).padStart(2, '0')}`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const every = (ms: number) => (ms >= 60_000 ? `every ${Math.round(ms / 60_000)} min` : `every ${Math.round(ms / 1000)} s`);

/**
 * What work is doing in the background — the PR check, the PR / Jira lists,
 * idle sleep, the Clean up scans — and what it decided. In the top bar a
 * small dot, grey unless a job needs you (resting, or failing after it
 * worked: activity-view.ts); its tooltip says what runs now. Clicking opens
 * the panel: now, coming up, and recent runs with their decisions (each
 * linked to its session; uneventful repeats folded into one row).
 */
export function ActivityIndicator({ onOpenSession, load = fetchActivity }: Props) {
  const [data, setData] = useState<ActivityWire | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const reload = useCallback(() => {
    load().then(setData, () => {
      /* server restarting: keep the last */
    });
  }, [load]);
  useEffect(reload, [reload]);
  useSse('/events', { events: { 'activity-changed': reload }, onOpen: reload });
  // Countdowns tick while the panel is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const running = data?.running ?? [];
  const attention = activityAttention(data, Date.now());
  const line = attention ?? activityQuietLine(data);

  return (
    <div className="wd-activity" ref={ref}>
      <button
        type="button"
        className={'wd-activity-dot-btn' + (attention ? ' wd-activity-attention' : '')}
        aria-expanded={open}
        aria-label={`Background jobs: ${line}`}
        title={`Background jobs: ${line}
Click for what work does in the background, and what it decided`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={'wd-activity-dot' + (running.length ? ' wd-activity-dot-busy' : '')} aria-hidden />
      </button>
      {open && (
        <div className="wd-activity-panel" role="dialog" data-popover aria-label="Background activity">
          <section>
            <h3 className="wd-legend-title">Now</h3>
            {running.length === 0 ? (
              <p className="wd-activity-empty">Nothing running.</p>
            ) : (
              running.map((r) => <RunRow key={r.id} run={r} onOpenSession={onOpenSession} />)
            )}
          </section>
          {(data?.schedules.length ?? 0) > 0 && (
            <section>
              <h3 className="wd-legend-title">Coming up</h3>
              <ul className="wd-activity-list">
                {data!.schedules.map((s) => (
                  <ScheduleRow key={s.kind} s={s} now={now} />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="wd-legend-title">Recent</h3>
            {(data?.recent.length ?? 0) === 0 ? (
              <p className="wd-activity-empty">Nothing yet.</p>
            ) : (
              collapseRuns(data!.recent).map((r) => <RunRow key={r.id} run={r} onOpenSession={onOpenSession} />)
            )}
          </section>
          <p className="wd-activity-version">work v{VERSION}</p>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ s, now }: { s: ActivitySchedule; now: number }) {
  const resting = s.pausedUntil && Date.parse(s.pausedUntil) > now;
  return (
    <li className="wd-activity-schedule">
      <span className="wd-activity-name">{s.label}</span>{' '}
      <span className="wd-activity-muted">
        {resting ? (
          <span className="wd-activity-warn">
            resting until {clock(s.pausedUntil!)}: {s.pausedWhy}
          </span>
        ) : (
          <>
            {every(s.everyMs)}
            {s.nextAt ? ` · next ${countdown(s.nextAt, now)}` : ''}
          </>
        )}
      </span>
    </li>
  );
}

const STATUS_MARK: Record<ActivityRun['status'], string> = { running: '', done: '✓', failed: '✗', skipped: '⏸' };
const NOTES_SHOWN = 4;

function RunRow({ run, onOpenSession }: { run: ActivityRun; onOpenSession: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const notes = all ? run.notes : run.notes.slice(0, NOTES_SHOWN);
  return (
    <div className={`wd-activity-run wd-activity-run-${run.status}`}>
      <div className="wd-activity-head">
        {run.status === 'running' ? (
          <span className="wd-activity-spinner" aria-hidden />
        ) : (
          <span className="wd-activity-mark">{STATUS_MARK[run.status]}</span>
        )}
        <span className="wd-activity-name">{run.label}</span>
        {run.status === 'running' && run.progress && run.progress.total > 0 && (
          <progress
            className="wd-activity-progress"
            max={run.progress.total}
            value={run.progress.done}
            aria-label={`${run.progress.done} of ${run.progress.total}`}
          />
        )}
        <span className="wd-activity-muted wd-activity-when">
          {run.status === 'running' ? `started ${relativeTime(run.startedAt)}` : relativeTime(run.endedAt ?? run.startedAt)}
          {run.repeats ? ` · ×${run.repeats + 1}` : ''}
        </span>
      </div>
      {run.summary && <div className="wd-activity-summary">{run.summary}</div>}
      {notes.length > 0 && (
        <ul className="wd-activity-notes">
          {notes.map((n, i) => (
            <li key={i} className={`wd-activity-note wd-activity-note-${n.level}`}>
              {n.sessionId ? (
                <button type="button" className="wd-link-button" onClick={() => onOpenSession(n.sessionId!)} title="Open this session">
                  {n.text}
                </button>
              ) : (
                n.text
              )}
            </li>
          ))}
          {run.notes.length > NOTES_SHOWN && (
            <li>
              <button type="button" className="wd-link-button wd-activity-more" onClick={() => setAll((a) => !a)}>
                {all ? 'Show fewer' : `Show all ${run.notes.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
