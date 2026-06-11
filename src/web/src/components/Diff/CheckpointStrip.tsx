import { useEffect, useRef, useState } from 'react';
import type {
  CheckpointEntry,
  CheckpointRangeEnd,
} from '../../api/client.js';

interface Props {
  entries: CheckpointEntry[];
  /** Currently selected "from" — always a checkpoint id (numeric). */
  fromId: number;
  /** Currently selected "to" — checkpoint id or `'working'` for the
   *  rightmost (live) endpoint. */
  toId: CheckpointRangeEnd;
  /** Set the left endpoint (shift+click a row) to widen the range start. */
  onChangeFrom: (id: number) => void;
  /** Set the right endpoint (used by the "All changes" preset). */
  onChangeTo: (id: CheckpointRangeEnd) => void;
  /** Plain-click a row: show JUST that checkpoint's own diff (previous →
   *  it). `'working'` = changes since the last checkpoint. */
  onPickSingle: (id: CheckpointRangeEnd) => void;
  /** Whether the range is currently driving the diff. When false the control
   *  is dimmed — a range is pinned for display, but the diff is showing a
   *  base view (Uncommitted / Since branch); picking a row activates it. */
  active: boolean;
  /** A diff fetch for the selected range is in flight. */
  busy?: boolean;
  /** Lazy Claude summary of what changed at the `to` checkpoint. */
  summary?: string | null;
  summaryLoading?: boolean;
}

/** Option label: the cached Claude summary if present, else `#id`. */
function entryLabel(e: CheckpointEntry): string {
  if (e.label && e.label.trim()) return e.label;
  return `#${e.id}`;
}

/** Compact relative time, e.g. "3m ago", "just now". Avoids a date lib. */
function relTime(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Checkpoint range picker, GitHub "Files changed" style: one button that
 * opens a popover listing every checkpoint. Click a row to set the right
 * endpoint, Shift+click to set the left endpoint; the rows between the two
 * highlight as the selected range. Stays on one line no matter how many
 * checkpoints a long session accumulates, and each row reads as a Claude
 * summary rather than a bare `#id`.
 */
export function CheckpointStrip({
  entries,
  fromId,
  toId,
  onChangeFrom,
  onChangeTo,
  onPickSingle,
  active,
  busy,
  summary,
  summaryLoading,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside-click / Escape so the popover behaves like a menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (entries.length === 0) return null;

  const toNumeric = toId === 'working' ? Number.POSITIVE_INFINITY : toId;
  const inRange = (id: number) => id >= fromId && id <= toNumeric;
  const nowMs = Date.now();

  const labelFor = (end: CheckpointRangeEnd): string => {
    if (end === 'working') return 'Working';
    const e = entries.find((x) => x.id === end);
    return e ? entryLabel(e) : `#${end}`;
  };

  // Plain click = show that ONE checkpoint's diff (previous → it). Shift+click
  // = widen the range's start to here (a left "working" is meaningless /
  // server-rejected). Shift keeps the popover open for range building.
  const pick = (e: React.MouseEvent, end: CheckpointRangeEnd) => {
    if (e.shiftKey) {
      if (end !== 'working') onChangeFrom(end);
    } else {
      onPickSingle(end);
    }
  };

  return (
    <nav
      ref={rootRef}
      className={
        'wd-checkpoint-range' +
        (active ? '' : ' wd-checkpoint-range-inactive')
      }
      aria-label="Checkpoint range"
      aria-busy={busy}
    >
      <div className="wd-checkpoint-range-row">
        <button
          type="button"
          className="wd-checkpoint-range-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title="Pick the range of checkpoints to diff"
        >
          <span className="wd-checkpoint-btn-tag">Range:</span>{' '}
          <span className="wd-checkpoint-btn-range">
            {labelFor(fromId)} <span aria-hidden="true">→</span> {labelFor(toId)}
          </span>
          <span className="wd-checkpoint-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {busy && (
          <span
            className="wd-checkpoint-spinner"
            role="status"
            aria-label="Loading diff"
          />
        )}
      </div>

      {(summary || summaryLoading) && (
        <div
          className="wd-checkpoint-summary"
          title="What changed at the selected checkpoint"
        >
          {/* Prefer the summary the moment it exists — never show
              "summarising…" once we have a name (guards against a stale
              loading flag from a races with the auto-latest pass). */}
          {summary ? (
            summary
          ) : (
            <span className="wd-checkpoint-summary-loading">summarising…</span>
          )}
        </div>
      )}

      {open && (
        <div className="wd-checkpoint-pop" role="listbox" aria-label="Checkpoints">
          {/* Pinned header: the "All changes" reset stays reachable no matter
              how far the checkpoint list scrolls. */}
          <div className="wd-checkpoint-pop-header">
            <button
              type="button"
              className={
                'wd-checkpoint-pop-preset' +
                (fromId === 0 && toId === 'working'
                  ? ' wd-checkpoint-pop-preset-active'
                  : '')
              }
              onClick={() => {
                onChangeFrom(0);
                onChangeTo('working');
              }}
            >
              <span className="wd-checkpoint-pop-dot" aria-hidden="true">
                {fromId === 0 && toId === 'working' ? '●' : ''}
              </span>
              All changes{' '}
              <span className="wd-checkpoint-pop-sub">Initial → Working</span>
            </button>
            <div className="wd-checkpoint-pop-hint">
              Click = just this checkpoint · Shift+click = widen start
            </div>
          </div>
          {entries.map((e) => {
            const isFrom = e.id === fromId;
            const isTo = toId !== 'working' && e.id === toId;
            const cls =
              'wd-checkpoint-pop-row' +
              (isFrom ? ' wd-checkpoint-pop-from' : '') +
              (isTo ? ' wd-checkpoint-pop-to' : '') +
              (!isFrom && !isTo && inRange(e.id)
                ? ' wd-checkpoint-pop-in-range'
                : '');
            return (
              <button
                key={e.id}
                type="button"
                role="option"
                aria-selected={isFrom || isTo}
                className={cls}
                onClick={(ev) => pick(ev, e.id)}
              >
                <span className="wd-checkpoint-pop-dot" aria-hidden="true">
                  {isFrom || isTo ? '●' : inRange(e.id) ? '▪' : ''}
                </span>
                <span className="wd-checkpoint-pop-label">{entryLabel(e)}</span>
                <span className="wd-checkpoint-pop-time">{relTime(e.ts, nowMs)}</span>
              </button>
            );
          })}
          {/* No standalone "Working (live)" row: as a single pick it's
              almost always identical to the last checkpoint. The live tree is
              still reachable as the right end of a range via the pinned
              "All changes" (Initial → Working) + Shift+click to narrow the
              start. */}
        </div>
      )}
    </nav>
  );
}
