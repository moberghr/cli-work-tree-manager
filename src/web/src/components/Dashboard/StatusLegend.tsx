import { useEffect, useRef, useState } from 'react';
import { StatusIcon } from './StatusIcon.js';
import { DISPLAY_LABEL, DISPLAY_MEANING, LEGEND_KINDS } from '../../state/session-display.js';

/**
 * "What do the colours mean?" — a "?" beside the sessions list that opens
 * the legend: every status dot with its name and what it means, from the
 * same vocabulary the dots use (session-view.ts), plus the row marks.
 */
export function StatusLegend() {
  // Where the panel opens: beside the button, in the window (the rail clips
  // anything wider than itself).
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) return setOpen(null);
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({ top: r.bottom + 6, left: Math.max(8, r.left - 8) });
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div className="wd-legend" ref={ref}>
      <button
        type="button"
        className="wd-dash-rail-new wd-legend-toggle"
        aria-expanded={!!open}
        aria-controls="wd-legend-panel"
        title="What the icons mean"
        aria-label="What the icons mean"
        onClick={toggle}
      >
        ?
      </button>
      {open && (
        <div
          id="wd-legend-panel"
          className="wd-legend-panel"
          role="dialog"
          aria-label="What the icons mean"
          style={{ top: open.top, left: open.left }}
        >
          <h3 className="wd-legend-title">What the icons mean</h3>
          <ul className="wd-legend-list">
            {LEGEND_KINDS.map((k) => (
              <li key={k} className="wd-legend-row">
                <StatusIcon kind={k} />
                <span className="wd-legend-name">{DISPLAY_LABEL[k]}</span>
                <span className="wd-legend-meaning">{DISPLAY_MEANING[k]}</span>
              </li>
            ))}
          </ul>
          <h3 className="wd-legend-title">On a row</h3>
          <ul className="wd-legend-list wd-legend-marks">
            <li>
              <b>Bold</b> — it wants you (needs input, done, review comments). The Inbox lists these in order; <kbd>n</kbd> jumps to the
              next.
            </li>
            <li>
              On the right: <span className="wd-rail-slot-needs">4m</span> waiting that long for you ·{' '}
              <span className="wd-rail-slot-done">4m</span> finished that long ago · <span className="wd-rail-slot-review">2</span>{' '}
              unresolved review comments
            </li>
            <li>
              <span className="wd-pr-chip">#212</span> an open pull request (click to open it)
            </li>
            <li>
              <span className="wd-legend-overlap">⚠</span> another session changes the same files
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
