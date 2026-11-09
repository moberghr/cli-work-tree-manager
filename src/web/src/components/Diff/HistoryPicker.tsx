import { useEffect, useRef, useState } from 'react';
import {
  inSelection,
  pick,
  selectionKey,
  selectionLabel,
  SINCE_BRANCH,
  UNCOMMITTED,
  type BranchGroup,
  type DiffSelection,
  type HistoryItem,
  type LookEntry,
} from '../../state/diff-history.js';
import { relativeTime } from '../../utils/time.js';
import type { SessionBranchWire } from '../../api/client.js';
import { branchNote } from '../../state/branches.js';

interface Props {
  /** Oldest first (historyItems); shown newest first. */
  items: HistoryItem[];
  selection: DiffSelection;
  onSelect: (sel: DiffSelection) => void;
  /** The shortcuts on top: present only when they mean something. */
  lastTurn: DiffSelection | null;
  sinceLooked: DiffSelection | null;
  /** Your looks, newest first (yourLooks): the newest is "Last look" on top, all of them a section above the history. */
  looks?: LookEntry[];
  /** A group: the commits listed are this repo's (the tab on screen). */
  commitsOf?: string | null;
  /** The other branches the session worked on, with their commits (branchGroups): listed after this one's. */
  groups?: BranchGroup[];
  /** What's known of each branch (the session row's `branches`): "not pushed", its PR. */
  branches?: SessionBranchWire[];
  /** The branch checked out (the repo on screen's): names this branch's section when others are listed. */
  current?: string | null;
}

/**
 * "Changes: … ▾" — the standalone review page's checkpoint picker, with the
 * branch's commits beside the turns: one button that opens a list, newest
 * first. A click shows just that one; Shift+click shows the span from the
 * last click to it, across commits and turns. Always there, in either scope.
 */
/** Looks shown before "Show all". */
const LOOKS_SHOWN = 5;

export function HistoryPicker({
  items,
  selection,
  onSelect,
  lastTurn,
  sinceLooked,
  looks = [],
  commitsOf,
  groups = [],
  branches = [],
  current,
}: Props) {
  const [open, setOpen] = useState(false);
  const [allLooks, setAllLooks] = useState(false);
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
  const commitCount = items.filter((i) => i.kind === 'commit' && !i.branch).length;
  const rows = items.filter((i) => !i.branch).reverse();
  const row = (it: HistoryItem) => {
    const on = inSelection(items, selection, it.key);
    return (
      <button
        key={it.key}
        type="button"
        role="option"
        aria-selected={on}
        className={'wd-checkpoint-pop-row wd-history-row wd-history-row-' + it.kind + (on ? ' wd-checkpoint-pop-in-range' : '')}
        title={
          it.switched
            ? `This turn switched branches (${it.switched}): its diff is mostly the other branch's files, not a change Claude made or undid.`
            : undefined
        }
        onClick={(ev) => {
          // A span from a row that isn't in this list (gone since), or on another branch, is just this row.
          const from = ev.shiftKey && anchor && items.some((x) => x.key === anchor && x.branch === it.branch) ? anchor : null;
          const sel = pick(it.key, from);
          if (!ev.shiftKey) setAnchor(it.key);
          choose(sel, ev.shiftKey);
        }}
      >
        <span className="wd-history-mark" aria-hidden="true">
          {it.kind === 'commit' ? '◆' : it.kind === 'turn' ? '◇' : '●'}
        </span>
        <span className="wd-history-tag">{it.tag}</span>
        <span className="wd-checkpoint-pop-label">
          {it.switched && <span className="wd-history-switch">branch switched: {it.switched}</span>}
          {it.switched && it.title ? ' · ' : ''}
          {it.title}
        </span>
        <span className="wd-checkpoint-pop-time">{it.at ? relativeTime(it.at) : 'now'}</span>
      </button>
    );
  };

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
              {looks[0] && preset('Last look', { ...looks[0].selection, label: 'Last look' }, looks[0].when)}
            </div>
            <div className="wd-checkpoint-pop-hint">
              Click: just that one · Shift+click: from the last click to it
              {commitsOf ? ` · commits of ${commitsOf}, turns of every repo` : ''}
            </div>
          </div>
          {looks.length > 0 && (
            <div className="wd-history-looks" role="group" aria-label="Your looks">
              <div className="wd-history-section">Your looks</div>
              {(allLooks ? looks : looks.slice(0, LOOKS_SHOWN)).map((l) => {
                const on = selectionKey(selection) === selectionKey(l.selection);
                return (
                  <button
                    key={l.key}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={'wd-checkpoint-pop-row wd-history-row wd-history-row-look' + (on ? ' wd-checkpoint-pop-in-range' : '')}
                    onClick={() => {
                      setAnchor(null);
                      choose(l.selection);
                    }}
                  >
                    <span className="wd-history-mark" aria-hidden="true">
                      ◉
                    </span>
                    <span className="wd-history-tag">{l.when}</span>
                    <span className="wd-checkpoint-pop-label">{l.turns}</span>
                  </button>
                );
              })}
              {!allLooks && looks.length > LOOKS_SHOWN && (
                <button type="button" className="wd-link-button wd-history-more" onClick={() => setAllLooks(true)}>
                  Show all {looks.length}
                </button>
              )}
              <div className="wd-history-section">History</div>
            </div>
          )}
          {groups.length > 0 && <div className="wd-history-section">{current ? `On ${current} (checked out)` : 'This branch'}</div>}
          {rows.map(row)}
          {rows.length === 1 && <p className="wd-history-empty">No commits on this branch and no finished turns yet.</p>}
          {groups.map((g) => {
            const note = branchNote(branches.find((b) => b.name === g.branch && (!commitsOf || b.repo === commitsOf)) ?? null);
            return (
              <div key={g.branch} className="wd-history-branch" role="group" aria-label={`Branch ${g.branch}`}>
                <div className="wd-history-section">
                  {g.branch}
                  {note && <span className="wd-history-branch-note"> · {note}</span>}
                </div>
                {g.items.map(row)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
