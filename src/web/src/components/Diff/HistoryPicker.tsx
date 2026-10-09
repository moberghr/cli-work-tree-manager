import { useEffect, useRef, useState } from 'react';
import {
  inSelection,
  pick,
  selectionKey,
  selectionLabel,
  SINCE_BRANCH,
  UNCOMMITTED,
  type DiffSelection,
  type HistoryItem,
} from '../../state/diff-history.js';
import { relativeTime } from '../../utils/time.js';

interface Props {
  /** Oldest first (historyItems); shown newest first. */
  items: HistoryItem[];
  selection: DiffSelection;
  onSelect: (sel: DiffSelection) => void;
  /** The shortcuts on top: present only when they mean something. */
  lastTurn: DiffSelection | null;
  sinceLooked: DiffSelection | null;
  /** A group: the commits listed are this repo's (the tab on screen). */
  commitsOf?: string | null;
}

/**
 * "Changes: … ▾" — the standalone review page's checkpoint picker, with the
 * branch's commits beside the turns: one button that opens a list, newest
 * first. A click shows just that one; Shift+click shows the span from the
 * last click to it, across commits and turns. Always there, in either scope.
 */
export function HistoryPicker({ items, selection, onSelect, lastTurn, sinceLooked, commitsOf }: Props) {
  const [open, setOpen] = useState(false);
  // Where a Shift+click span starts: the last row clicked.
  const [anchor, setAnchor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a click elsewhere or Escape, like a menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // used: closing this, not leaving full screen as well
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (sel: DiffSelection, keepOpen = false) => {
    onSelect(sel);
    if (!keepOpen) setOpen(false);
  };
  const preset = (label: string, sel: DiffSelection | null, sub?: string) =>
    sel && (
      <button
        type="button"
        className={'wd-checkpoint-pop-preset' + (selectionKey(selection) === selectionKey(sel) ? ' wd-checkpoint-pop-preset-active' : '')}
        onClick={() => {
          setAnchor(null);
          choose(sel);
        }}
      >
        {label}
        {sub && <span className="wd-checkpoint-pop-sub"> {sub}</span>}
      </button>
    );
  const commitCount = items.filter((i) => i.kind === 'commit').length;
  const rows = [...items].reverse();

  return (
    <div ref={rootRef} className="wd-history" data-popover>
      <button
        type="button"
        className="wd-history-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Pick what to diff: a commit, a turn, or a span of them"
      >
        <span className="wd-history-btn-tag">Changes:</span>{' '}
        <span className="wd-history-btn-label">{selectionLabel(items, selection)}</span>
        <span className="wd-checkpoint-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="wd-checkpoint-pop wd-history-pop" role="listbox" aria-label="Commits and turns">
          <div className="wd-checkpoint-pop-header">
            <div className="wd-history-presets">
              {preset('Uncommitted', UNCOMMITTED)}
              {preset(
                'Everything on the branch',
                SINCE_BRANCH,
                commitCount ? `${commitCount} commit${commitCount === 1 ? '' : 's'} + uncommitted` : undefined,
              )}
              {preset('Last turn', lastTurn)}
              {preset('Since you looked', sinceLooked)}
            </div>
            <div className="wd-checkpoint-pop-hint">
              Click: just that one · Shift+click: from the last click to it
              {commitsOf ? ` · commits of ${commitsOf}, turns of every repo` : ''}
            </div>
          </div>
          {rows.map((it) => {
            const on = inSelection(items, selection, it.key);
            return (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={on}
                className={'wd-checkpoint-pop-row wd-history-row wd-history-row-' + it.kind + (on ? ' wd-checkpoint-pop-in-range' : '')}
                onClick={(ev) => {
                  // A span from a row that isn't in this list (gone since) is just this row.
                  const from = ev.shiftKey && anchor && items.some((x) => x.key === anchor) ? anchor : null;
                  const sel = pick(it.key, from);
                  if (!ev.shiftKey) setAnchor(it.key);
                  choose(sel, ev.shiftKey);
                }}
              >
                <span className="wd-history-mark" aria-hidden="true">
                  {it.kind === 'commit' ? '◆' : it.kind === 'turn' ? '◇' : '●'}
                </span>
                <span className="wd-history-tag">{it.tag}</span>
                <span className="wd-checkpoint-pop-label">{it.title}</span>
                <span className="wd-checkpoint-pop-time">{it.at ? relativeTime(it.at) : 'now'}</span>
              </button>
            );
          })}
          {rows.length === 1 && <p className="wd-history-empty">No commits on this branch and no finished turns yet.</p>}
        </div>
      )}
    </div>
  );
}
